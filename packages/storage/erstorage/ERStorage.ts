import {EntityToTableMap} from "./EntityToTableMap";
import {assert, deepMerge, setByPath} from "../util";
// @ts-ignore
import {BoolExpression, ExpressionData} from '../../shared/BoolExpression'
// @ts-ignore
import {Database, EntityIdRef, ROW_ID_ATTR} from '../../runtime/System'
import {FieldMatchAtom, MatchAtom, MatchExpression, MatchExpressionData} from "./MatchExpression.ts";
import {ModifierData} from "./Modifier.ts";
import {AttributeQuery, AttributeQueryData, AttributeQueryDataItem} from "./AttributeQuery.ts";
import {RecordQueryData, RecordQueryTree, RecordQuery} from "./RecordQuery.ts";
import {NewRecordData, RawEntityData} from "./NewRecordData.ts";
import {someAsync} from "./util.ts";


export type JoinTables = {
    for: any
    joinSource: [string, string]
    joinIdField: [string, string]
    joinTarget: [string, string]
}[]

export class QueryAgent {
    constructor(public map: EntityToTableMap, public database: Database) {}
    buildFindQuery(entityQuery: RecordQuery, prefix='') {
        // 从所有条件里面构建出 join clause
        const fieldQueryTree = entityQuery.attributeQuery!.xToOneQueryTree
        const matchQueryTree = entityQuery.matchExpression.entityQueryTree
        const finalQueryTree = deepMerge(fieldQueryTree, matchQueryTree)

        const joinTables = this.getJoinTables(finalQueryTree, [entityQuery.recordName])

        const fieldMatchExp = entityQuery.matchExpression.buildFieldMatchExpression()

        return `
SELECT ${prefix ? '' : 'DISTINCT'}
${this.buildSelectClause(entityQuery.attributeQuery.getQueryFields(), prefix)}
FROM
${this.buildFromClause(entityQuery.recordName, prefix)}
${this.buildJoinClause(joinTables, prefix)}
${fieldMatchExp ? `
WHERE
${this.buildWhereClause( 
    this.parseMatchExpressionValue(entityQuery.recordName, fieldMatchExp , entityQuery.contextRootEntity),
    prefix
)}
` : ''}   
`
        // FIXME 添加 modifier
    }
    structureRawReturns(rawReturns: {[k:string]: any}[]) {
        return rawReturns.map(rawReturn => {
            const obj = {}
            Object.entries(rawReturn).forEach(([key, value]) => {
                // CAUTION 注意这里去掉了最开始的 entityName
                setByPath(obj, key.split('.').slice(1, Infinity), value)
            })
            return obj
        })
    }
    // 查 entity 和 查 relation 都是一样的。具体在 entityQuery 里面区别。
    async findRecords(entityQuery:RecordQuery, queryName='') : Promise<any[]>{
        // 1. 这里只通过合表或者 join  处理了 x:1 的关联查询。x:n 的查询是通过二次查询获取的。
        const data = this.structureRawReturns(await this.database.query(this.buildFindQuery(entityQuery), queryName)) as any[]
        // 2. TODO 关联数据的结构化。也可以把信息丢到客户端，然客户端去结构化？？？

        // 3. x:n 关联实体的查询
        if (entityQuery.attributeQuery!.xToManyRecords) {
            for (let relatedEntity of entityQuery.attributeQuery.xToManyRecords) {
                const {name: attributeName, entityQuery: subEntityQuery} = relatedEntity
                for (let entity of data) {
                    entity[attributeName] = await this.findRelatedRecords(entityQuery.recordName, attributeName, entity.id, subEntityQuery)
                }
            }
        }

        return data
    }
    async findRelatedRecords(recordName: string, attributeName: string, recordId: string, subEntityQuery: RecordQuery) {
        const reverseInfo = this.map.getInfo(recordName, attributeName).getReverseInfo()

        const newMatch = subEntityQuery.matchExpression.and({
            key: `${reverseInfo?.attributeName!}.id`,
            value: ['=', recordId]
        })

        // FIXME 改成 create
        const newSubQuery = new RecordQuery(subEntityQuery.recordName, subEntityQuery.map, newMatch, subEntityQuery.attributeQuery, subEntityQuery.modifier, subEntityQuery.contextRootEntity)

        return this.findRecords(newSubQuery)
    }
    // 根据 queryTree 来获得 join table 的信息。因为 queryTree 是树形，所以这里也是个递归结构。
    getJoinTables(queryTree: RecordQueryTree, context: string[] = [], parentInfos?: [string, string, string]) :JoinTables {
        // 应该是深度 遍历？
        const result: JoinTables = []
        if (!parentInfos) {
            //  context 里面至少会有 entityName 这一个值。
            const parentNamePath = [context[0]]
            parentInfos = (this.map.getTableAndAlias(parentNamePath).slice(0, 2))
                .concat(this.map.getTableAliasAndFieldName(parentNamePath, 'id')[1])  as [string, string, string]
        }

        const parentTableAndAlias = parentInfos.slice(0, 2) as [string, string]
        const parentIdField = parentInfos[2]

        Object.entries(queryTree).forEach(([entityAttributeName, subQueryTree]) => {

            const attributeInfo = this.map.getInfoByPath(context.concat(entityAttributeName))

            assert(attributeInfo.isRecord, `${context.concat(entityAttributeName).join('.')} is not a record`)

            const [currentTable, currentTableAlias, /*lastEntityData*/,relationTable, relationTableAlias] = this.map.getTableAndAlias(context.concat(entityAttributeName))
            const [, idField] = this.map.getTableAliasAndFieldName(context.concat(entityAttributeName), 'id')
            // 这里的目的是把 attribute 对应的 record table 找到，并且正确 join 进来。
            // join 本质上是把当前的路径和上一级路径连起来。
            // 这里只处理没有和上一个节点 三表合一 的情况。三表合一的情况不需要 join。复用 alias 就行
            if (!attributeInfo.isMergedWithParent()) {
                // 这里要判断的是 关联 id 是记录在了哪里？
                // 如果 attributeInfo 自己就有 field，说明就是自己记录的
                if (attributeInfo.isLinkMergedWithParent()) {
                    result.push({
                        for: context.concat(entityAttributeName),
                        joinSource: parentTableAndAlias!,
                        joinIdField: [attributeInfo.field, idField],
                        joinTarget: [currentTable, currentTableAlias]
                    })
                } else if (attributeInfo.isLinkMergedWithAttribute()){
                    const reverseAttributeInfo = attributeInfo.getReverseInfo()
                    // 说明记录在对方的 field 里面
                    result.push({
                        for: context.concat(entityAttributeName),
                        joinSource: parentTableAndAlias!,
                        // 这里要找当前实体中用什么 attributeName 指向上一个实体
                        joinIdField: [parentIdField, reverseAttributeInfo.field],
                        joinTarget: [currentTable, currentTableAlias]
                    })
                } else {
                    // 说明记录在了 relation record 的 source/target 中
                    const linkInfo = attributeInfo.getLinkInfo()
                    const isCurrentRelationSource = linkInfo.isRelationSource(attributeInfo.parentEntityName, attributeInfo.attributeName)
                    // 关系表独立
                    result.push({
                        for: context.concat(entityAttributeName),
                        joinSource: parentTableAndAlias!,
                        // CAUTION sourceField 是用在合并了情况里面的，指的是 target 在 source 里面的名字！所以这里不能用
                        joinIdField: [parentIdField, isCurrentRelationSource ? linkInfo.record.attributes.source.field! : linkInfo.record.attributes.target.field!],
                        joinTarget: [relationTable, relationTableAlias]
                    })

                    result.push({
                        for: context.concat(entityAttributeName),
                        joinSource: [relationTable, relationTableAlias],
                        joinIdField: [isCurrentRelationSource ? linkInfo.record.attributes.target.field! : linkInfo.record.attributes.source.field!, idField],
                        joinTarget: [currentTable, currentTableAlias]
                    })
                }
            }
            result.push(...this.getJoinTables(subQueryTree, context.concat(entityAttributeName), [currentTable!, currentTableAlias!, idField!]))
        })

        return result
    }
    withPrefix(prefix ='') {
        return prefix? `${prefix}___` : ''
    }
    buildSelectClause(queryFields: ReturnType<AttributeQuery["getQueryFields"]>, prefix=''){
        if (!queryFields.length) return '1'
        // CAUTION 所有 entity 都要 select id
        return queryFields.map(({tableAliasAndField, attribute, nameContext}) => (
            `${this.withPrefix(prefix)}${tableAliasAndField[0]}.${tableAliasAndField[1]} AS \`${this.withPrefix(prefix)}${nameContext.join(".")}.${attribute}\``
        )).join(',\n')
    }
    buildFromClause(entityName: string, prefix='') {
        return `${this.map.getRecordTable(entityName)} AS \`${this.withPrefix(prefix)}${entityName}\``
    }
    buildJoinClause(joinTables: JoinTables, prefix='') {
        return joinTables.map(({ joinSource, joinIdField, joinTarget}) => {
            return `LEFT JOIN ${joinTarget[0]} AS 
\`${this.withPrefix(prefix)}${joinTarget[1]}\` ON 
\`${this.withPrefix(prefix)}${joinSource[1]}\`.${joinIdField[0]} = \`${this.withPrefix(prefix)}${joinTarget[1]}\`.${joinIdField[1]}
`
        }).join('\n')
    }
    buildWhereClause(fieldMatchExp: BoolExpression<FieldMatchAtom>|null, prefix=''): string {
        if (!fieldMatchExp) return '1=1'

        if (fieldMatchExp.isAtom()) {
            return fieldMatchExp.data.isInnerQuery ? fieldMatchExp.data.fieldValue! : `${this.withPrefix(prefix)}${fieldMatchExp.data.fieldName![0]}.${fieldMatchExp.data.fieldName![1]} ${fieldMatchExp.data.fieldValue}`
        } else {
            if (fieldMatchExp.isAnd()) {
                return `(${this.buildWhereClause(fieldMatchExp.left, prefix)} AND ${this.buildWhereClause(fieldMatchExp.right, prefix)})`
            } else  if (fieldMatchExp.isOr()) {
                return `(${this.buildWhereClause(fieldMatchExp.left, prefix)} OR ${this.buildWhereClause(fieldMatchExp.right, prefix)})`
            } else {
                return `NOT (${this.buildWhereClause(fieldMatchExp.left, prefix)})`
            }
        }
    }

    // 把 match 中的 exist 创建成子 sql
    parseMatchExpressionValue(entityName: string, fieldMatchExp: BoolExpression<FieldMatchAtom>|null, contextRootEntity? :string): BoolExpression<FieldMatchAtom>|null {
        if (!fieldMatchExp) return null

        return fieldMatchExp.map((exp: BoolExpression<FieldMatchAtom>, context:string[]) => {
            assert(Array.isArray(exp.data.value), `match value is not a array ${context.join('.')}`)
            if (exp.data.isFunctionMatch) {
                assert(exp.data.value[0].toLowerCase() === 'exist', `we only support Exist function match on entity for now. yours: ${exp.data.key} ${exp.data.value[0]} ${exp.data.value[1]}`)

                const info = this.map.getInfoByPath(exp.data.namePath!)
                const [, currentAlias] = this.map.getTableAndAlias(exp.data.namePath!)
                const [, parentAlias] = this.map.getTableAndAlias(exp.data.namePath!.slice(0, -1))
                const reverseAttributeName = this.map.getReverseAttribute(info.parentEntityName, info.attributeName)

                // 注意这里去掉了 namePath 里面根部的 entityName，因为后面计算 referenceValue 的时候会加上。
                const parentAttributeNamePath = exp.data.namePath!.slice(1, -1)

                const existEntityQuery = RecordQuery.create(info.recordName, this.map, {
                        matchExpression: BoolExpression.createFromAtom({
                            key: `${reverseAttributeName}.id`,
                            value: ['=', parentAttributeNamePath.concat('id').join('.')],
                            isReferenceValue: true
                        } as MatchAtom).and(exp.data.value[1] instanceof BoolExpression ? exp.data.value[1] : MatchExpression.createFromAtom(exp.data.value[1]))
                    },
                    // 如果上层还有，就继承上层的，如果没有， context 就只这一层。这个变量是用来给 matchExpression 里面的 value 来引用上层的值的。
                    //  例如查询用户，要求他存在一个朋友的父母的年龄是小于这个用户。对朋友的父母的年龄匹配中，就需要引用最上层的 alias。
                    contextRootEntity||entityName
                )

                return {
                    ...exp.data,
                    isInnerQuery: true,
                    fieldValue: `
EXISTS (
${this.buildFindQuery(existEntityQuery, currentAlias)}
)
`
                }
            } else {
                return {
                    ...exp.data,
                }
            }
        })
    }


    async createRecordDependency(newRecordData: NewRecordData) : Promise<NewRecordData>{
        const newRecordDataWithDeps: {[k:string]: EntityIdRef} = {}
        // 处理往自身合并的需要新建的关系和 record
        for( let mergedLinkTargetRecord of newRecordData.mergedLinkTargetNewRecords.concat(newRecordData.mergedLinkTargetRecordIdRefs)) {
            let newDepIdRef
            if (!mergedLinkTargetRecord.isRef()) {
                newDepIdRef = await this.createRecord(mergedLinkTargetRecord)
            } else {
                newDepIdRef = mergedLinkTargetRecord.getRef()
            }
            newRecordDataWithDeps[mergedLinkTargetRecord.info!.attributeName] = newDepIdRef

            if (mergedLinkTargetRecord.linkRecordData) {
                // 为 link 也要把 dependency 准备好。
                const newLinkRecordData = mergedLinkTargetRecord.linkRecordData.merge({
                    [mergedLinkTargetRecord.info!.isRecordSource() ? 'target': 'source'] : newDepIdRef
                })
                // 所有 Link dep 也准备好了
                const newLinkRecordDataWithDep = await this.createRecordDependency(newLinkRecordData)

                newRecordDataWithDeps[mergedLinkTargetRecord.info!.attributeName]['&'] = newLinkRecordDataWithDep.getData()
            }
        }

        // 处理三表合一的 link record 的 dependency
        for( let combinedRecord of newRecordData.combinedNewRecords.concat(newRecordData.combinedRecordIdRefs)) {
            if (combinedRecord.linkRecordData) {
                const newLinkRecordDataWithDep = await this.createRecordDependency(combinedRecord.linkRecordData)
                newRecordDataWithDeps[combinedRecord.info!.attributeName] = {
                    // 注意这里原本的数据不能丢，因为下面的 merge 不是深度 merge。
                    ...combinedRecord.getData(),
                    '&': newLinkRecordDataWithDep.getData()
                }
            }
        }

        // 返回追备好 link 数据和准备好 record 数据的新 newRecordData
        return newRecordData.merge(newRecordDataWithDeps)
    }

    async createRecord(newEntityData: NewRecordData) : Promise<EntityIdRef>{
        const newEntityDataWithDep = await this.createRecordDependency(newEntityData)
        const newRecordIdRef = await this.insertSameRowData(newEntityDataWithDep, newEntityData.isRef())

        const relianceResult = await this.handleReliance(newEntityDataWithDep.merge(newRecordIdRef))

        // 更新 relianceResult 的信息到
        return Object.assign(newRecordIdRef, relianceResult)
    }

    async prepareSameRowData(newEntityData: NewRecordData, ignoreSelfId = false): Promise<NewRecordData> {
        const newRawDataWithNewIds = newEntityData.getData()
        // 1. 先为三表合一的新数据分配 id
        for(let record of newEntityData.combinedNewRecords) {
            newRawDataWithNewIds[record.info!.attributeName] = {
                ...newRawDataWithNewIds[record.info!.attributeName],
                id: await this.database.getAutoId(record.info!.recordName!),
            }
        }

        // 2. 为我要新建 三表合一、或者我 mergedLink 的 的关系分配 id.
        for(let record of newEntityData.mergedLinkTargetNewRecords.concat(newEntityData.mergedLinkTargetRecordIdRefs, newEntityData.combinedNewRecords)) {
            newRawDataWithNewIds[record.info!.attributeName]['&'] = {
                ...(newRawDataWithNewIds[record.info!.attributeName]['&']||{}),
                id: await this.database.getAutoId(record.info!.linkName!),
            }
        }

        if (!ignoreSelfId) {
            newRawDataWithNewIds.id = await this.database.getAutoId(newEntityData.recordName)
        }

        const newEntityDataWithIds = newEntityData.merge(newRawDataWithNewIds)

        // 2. 处理需要 flashOut 的数据
        const flashOutRecordRasData:{[k:string]: RawEntityData} = {}
        // CAUTION 这里是从 newEntityData 里读，不是从 newEntityDataWithIds，那里面是刚分配id 的，还没数据。
        for(let combinedRecordIdRef of newEntityData.combinedRecordIdRefs) {
            const combinedRecordInfo = combinedRecordIdRef.info?.getRecordInfo()!
            const allRelatedRecords = combinedRecordInfo?.combinedRecords.map(info => info.attributeName!).filter(name => {
                // CAUTION 去掉反向的数据。不然死循环了。
                return name !== combinedRecordIdRef.info?.getReverseInfo()?.attributeName
            })

            const newMatch =  MatchExpression.createFromAtom({
                key: 'id',
                value: ['=', combinedRecordIdRef.getRef().id]
            })
            flashOutRecordRasData[combinedRecordIdRef.info?.attributeName!] = await this.flashOutRecords(combinedRecordInfo?.name!, newMatch, allRelatedRecords)
        }

        return newEntityDataWithIds.merge(flashOutRecordRasData)
    }

    async insertSameRowData(newEntityData: NewRecordData): Promise<EntityIdRef>{
        const newEntityDataWithIdsWithFlashOutRecords = await this.prepareSameRowData(newEntityData)
        // 3. 插入新行。
        const sameRowNewFieldAndValue = newEntityDataWithIdsWithFlashOutRecords.getSameRowFieldAndValue()
        const result = await this.database.insert(`
INSERT INTO ${this.map.getRecordTable(newEntityData.recordName)}
(${sameRowNewFieldAndValue.map(f => f.field).join(',')})
VALUES
(${sameRowNewFieldAndValue.map(f => JSON.stringify(f.value)).join(',')}) 
`) as EntityIdRef



        return Object.assign(result,newEntityDataWithIdsWithFlashOutRecords.getData())
    }


    async handleReliance(newEntityData: NewRecordData): Promise<object> {
        const currentIdRef = newEntityData.getRef()
        const newIdRefs: {[k:string]: EntityIdRef} = {}
        // 1. 处理关系往 attribute 方向合并的新数据
        for( let record of newEntityData.differentTableMergedLinkNewRecords) {
            const reverseAttribute = record.info?.getReverseInfo()?.attributeName
            const newRecordDataWithMyId = record.merge({
                [reverseAttribute] : currentIdRef
            })
            const newRecordIdRef = await this.createRecord(newRecordDataWithMyId)
            if (record.info!.isXToMany) {
                if (!newIdRefs[record.info!.attributeName]) {
                    newIdRefs[record.info!.attributeName] = []
                }
                newIdRefs[record.info!.attributeName].push(newRecordIdRef)
            } else {
                newIdRefs[record.info!.attributeName] = newRecordIdRef
            }
        }

        // 2. 处理关系往 attribute 方向合并的老数据
        for( let record of newEntityData.differentTableMergedLinkRecordIdRefs) {
            const reverseInfo = record.info!.getReverseInfo()
            const idMatch = MatchExpression.createFromAtom({
                key: 'id',
                value: ['=', record.getRef().id]
            })
            const newData = {
                [reverseInfo!.attributeName]: currentIdRef,
                '&': record.getData()['&']
            }
            await this.updateRecord(reverseInfo.parentEntityName, idMatch, new NewRecordData(this.map, reverseInfo.parentEntityName, newData))
        }

        // 3. 处理完全独立的新数据和关系
        for( let record of newEntityData.isolatedNewRecords) {
            const newRecordIdRef = await this.createRecord(record)
            if (record.info!.isXToMany) {
                if (!newIdRefs[record.info!.attributeName]) {
                    newIdRefs[record.info!.attributeName] = []
                }
                newIdRefs[record.info!.attributeName].push(newRecordIdRef)
            } else {
                newIdRefs[record.info!.attributeName] = newRecordIdRef
            }

            const linkRawData: RawEntityData = record.linkRecordData?.getData() || {}
            Object.assign(linkRawData, {
                source: record.info!.isRecordSource() ? currentIdRef : newRecordIdRef,
                target: record.info!.isRecordSource() ? newRecordIdRef : currentIdRef
            })
            const newLinkData = new NewRecordData(this.map, record.info!.linkName, linkRawData)
            await this.createRecord(newLinkData)
        }

        // 4. 处理完全独立数据和的关系。
        for (let record of newEntityData.isolatedRecordIdRefs) {
            // 针对 x:1 关系要先删除原来的关系
            if(record.info!.isXToOne) {
                const match = MatchExpression.createFromAtom({
                    key: record.info?.isRecordSource() ? 'target.id' : 'source.id',
                    value: ['=', record.getRef().id]
                })
                await this.unlink(record.info!.linkName, match)
            }
            const linkRawData: RawEntityData = record.linkRecordData?.getData() || {}
            Object.assign(linkRawData, {
                source: record.info!.isRecordSource() ? currentIdRef : record.getRef(),
                target: record.info!.isRecordSource() ? record.getRef() : currentIdRef
            })
            const newLinkData = new NewRecordData(this.map, record.info!.linkName, linkRawData)

            await this.createRecord(newLinkData)
        }

        return newIdRefs
    }


    // CAUTION 除了 1:1 并且合表的关系，不能递归更新 relatedEntity，如果是传入了，说明是建立新的关系。
    async updateRecordDataByIds(entityName: string, idRefs: {id:string}[], columnAndValue: {field:string, value:string}[]): Promise<EntityIdRef[]>  {
        // TODO 要更新拆表出去的 field

        const idField= this.map.getInfo(entityName, 'id').field

        // CAUTION update 语句可以有 别名和 join，但似乎 SET 里面不能用主表的 别名!!!
        if (columnAndValue.length) {
            await this.database.update(`
UPDATE ${this.map.getRecordTable(entityName)}
SET
${columnAndValue.map(({field, value}) => `
${field} = ${value}
`).join(',')}
WHERE ${idField} IN (${idRefs.map(i => JSON.stringify(i.id)).join(',')})
`, idField)
        }
        // 注意这里，使用要返回匹配的类，虽然可能没有更新数据。这样才能保证外部的逻辑比较一致。
        return idRefs
    }
    // 只有 1:1 关系可以递归更新实体数据，其他都能改当前实体的数据或者和其他实体关系。
    async updateRecord(entityName: string, matchExpressionData: MatchExpressionData, newEntityData: NewRecordData)  {

        // 1. 更新我依赖的
        const newEntityDataWithDep = await this.createRecordDependency(newEntityData)

        const matchedEntities = await this.findRecords(RecordQuery.create(entityName, this.map, {
            matchExpression: matchExpressionData,
        }), `find record for updating ${entityName}`)


        // 跟自己合表的必须先删除，不然下面 updateRecordData 的时候可能冲掉了。
        const sameRoleEntityRefOrNewData = newEntityData.combinedRecordIdRefs.concat(newEntityData.combinedNewRecords)

        for(let newRelatedEntityData of sameRoleEntityRefOrNewData) {
            const linkInfo = newRelatedEntityData.info!.getLinkInfo()
            const updatedEntityLinkAttr = linkInfo.isRelationSource(entityName, newRelatedEntityData.info!.attributeName) ? 'source' : 'target'
            for(let updatedEntity of matchedEntities) {
                await this.unlink(
                    linkInfo.name,
                    MatchExpression.createFromAtom({
                        key: `${updatedEntityLinkAttr}.id`,
                        value: ['=', updatedEntity.id],
                    }),
                    !linkInfo.isRelationSource(entityName, newRelatedEntityData.info!.attributeName)
                )
            }
        }

        // 2. 先更新自身的 value 和 三表合一 或者 关系表合并的情况
        const newEntityDataWithIdsWithFlashOutRecords = await this.prepareSameRowData(newEntityDataWithDep, true)
        const allSameRowData = newEntityDataWithIdsWithFlashOutRecords.getSameRowFieldAndValue()
        const columnAndValue = allSameRowData.map(({field, value}) => (
            {
                field,
                /// TODO value 要考虑引用自身或者 related entity 其他 field 的情况？例如 age+5
                value: JSON.stringify(value)
            }
        ))

        await this.updateRecordDataByIds(entityName, matchedEntities.map(e => ({id:e.id})), columnAndValue)
        // FIXME 这里验证一下三表合一情况下的数据正确性
        // if(newEntityData.sameRowEntityIds.length) {
        //     assert(updatedEntities.length === 1 && updatedEntities[0].id === newEntityData.reuseEntityId, `updated multiple records with only 1 1:1 related entity, ${updatedEntities[0].id} ${newEntityData.reuseEntityId}` )
        // }

        // 3. 更新依赖我的和关系表独立的
        // 3.1. 删除旧关系
        // CAUTION 这里的语义认为是 replace。对于 xToMany 的情况下，如果用户想表达新增，自己拆成两步进行。
        // CAUTION 由于 xToMany 的数组情况会平铺，所以这里可能出现两次，所以这里记录一下排重
        const otherTableEntitiesData = newEntityData.differentTableMergedLinkRecordIdRefs.concat(
            newEntityData.differentTableMergedLinkNewRecords,
            newEntityData.isolatedRecordIdRefs,
            newEntityData.isolatedNewRecords,
        )

        const removedLinkName = new Set()
        for(let newRelatedEntityData of otherTableEntitiesData) {
            const linkInfo = newRelatedEntityData.info!.getLinkInfo()
            if (removedLinkName.has(linkInfo.name)) {
                continue
            }

            removedLinkName.add(linkInfo.name)
            const updatedEntityLinkAttr = linkInfo.isRelationSource(entityName, newRelatedEntityData.info!.attributeName) ? 'source' : 'target'
            for(let updatedEntity of matchedEntities) {

                await this.unlink(
                    linkInfo.name,
                    MatchExpression.createFromAtom({
                        key: `${updatedEntityLinkAttr}.id`,
                        value: ['=', updatedEntity.id],
                    }),
                    !linkInfo.isRelationSource(entityName, newRelatedEntityData.info!.attributeName)
                )
            }
        }

        // 3.1. 建立新关系
        // 处理和其他实体更新关系的情况。
        for(let newRelatedEntityData of otherTableEntitiesData.concat(newEntityData.sameRowEntityIdRefs)) {
            // 这里只处理没有三表合并的场景。因为三表合并的数据在 sameTableFieldAndValues 已经有了
            // 这里只需要处理 1）关系表独立 或者 2）关系表往另一个方向合了的情况。因为往本方向和的情况已经在前面 updateEntityData 里面处理了
            let finalRelatedEntityRef

            if (newRelatedEntityData.isRef()) {
                finalRelatedEntityRef = newRelatedEntityData.getRef()
            } else {
                finalRelatedEntityRef = await this.createRecord(newRelatedEntityData)
            }

            for(let updatedEntity of matchedEntities) {
                await this.addLinkFromRecord(entityName, newRelatedEntityData.info?.attributeName!, updatedEntity.id, finalRelatedEntityRef.id)
            }
        }

        return matchedEntities.map(updatedEntity => Object.assign(updatedEntity, newEntityDataWithIdsWithFlashOutRecords.getData()))

    }

    async deleteRecord(recordName:string, matchExp: MatchExpressionData) {
        const deleteQuery = RecordQuery.create(recordName, this.map, {
            matchExpression: matchExp,
            attributeQuery: ['id']
        })
        const records = await this.findRecords(deleteQuery)

        if (records.length) {
            // 删除依赖我的
            await this.deleteDifferentTableReliance(recordName, records)
            // 删除自身
            await this.deleteRecordSameRowData(recordName, records)
            // 删除其他的关系
            await this.deleteNotReliantSeparateLinkRecords(recordName, records)
        }

        return records
    }

    async deleteRecordSameRowData(recordName: string, records: EntityIdRef[]) {
        const recordInfo = this.map.getRecordInfo(recordName)

        for(let record of records) {
            // FIXME 其实可以利用数据库 select * 来加速，怎么看这个问题？？
            const hasSameRowData = recordInfo.notReliantCombined.length && await someAsync(recordInfo.notReliantCombined, async (info) => {
                const existQuery = RecordQuery.create(
                    info.recordName,
                    this.map,
                    {
                        matchExpression:MatchExpression.createFromAtom({
                            key: `${info.getReverseInfo().attributeName}.id`,
                            value: ['=', record.id]
                        }),
                        attributeQuery:['id'],
                        modifier: {limit: 1}
                    }
                )
                const result = await this.findRecords(existQuery)
                return !!result.length
            })

            if (hasSameRowData) {
                // 存在同行 record，只能用 update
                const fields = recordInfo.sameRowFields
                return this.database.delete(`
UPDATE ${recordInfo.table}
SET ${fields.map(field => `${field} = NULL`).join(',')}
WHERE ${recordInfo.idField} IN (${records.map(({id}) => JSON.stringify(id)).join(',')})
`)

            } else {
                // 不存在同行数据 record ，可以 delete row

                await this.database.delete(`
DELETE FROM ${recordInfo.table}
WHERE ${recordInfo.idField} IN (${records.map(({id}) => JSON.stringify(id)).join(',')})
`)
            }
        }
    }


    async deleteNotReliantSeparateLinkRecords(recordName: string, record: EntityIdRef[]) {
        const recordInfo = this.map.getRecordInfo(recordName)
        for(let info of recordInfo.differentTableRecordAttributes) {
            if (!info.isReliance) {
                const key = info.isRecordSource() ? 'source.id' : 'target.id'
                const newMatch = MatchExpression.createFromAtom({
                    key,
                    value: ['in', record.map(r => r.id)]
                })
                await this.deleteRecord(info.linkName, newMatch)
            }
        }
    }

    // TODO 也许有 多个 reliance 也合表了，并且刚好可以一起删除的情况。
    async deleteDifferentTableReliance(recordName: string, records: EntityIdRef[]) {
        const recordInfo = this.map.getRecordInfo(recordName)
        for (let info of recordInfo.differentTableReliance) {
            const matchInIds = MatchExpression.createFromAtom({
                key: `${info.getReverseInfo()?.attributeName!}.id`,
                value: ['in', records.map(r => r.id)]
            })
            await this.deleteRecord(info.recordName, matchInIds)
        }
    }


    addLinkFromRecord(entity: string, attribute:string, entityId:string, relatedEntityId: string, attributes: RawEntityData = {}) {
        const linkInfo = this.map.getLinkInfo(entity, attribute)
        const isEntitySource = linkInfo.isRelationSource(entity, attribute)

        const sourceId = isEntitySource? entityId : relatedEntityId
        const targetId = isEntitySource? relatedEntityId: entityId

        return this.addLink(linkInfo.name, sourceId, targetId, attributes, !linkInfo.isRelationSource(entity, attribute))
    }

    async addLink(linkName: string, sourceId: string, targetId:string, attributes: RawEntityData = {}, moveSource = false) {
        const linkInfo = this.map.getLinkInfoByName(linkName)
        if (!linkInfo.isCombined() && !linkInfo.isMerged() && (linkInfo.isManyToOne || linkInfo.isOneToMany)) {
            // n 方向要 unlink ?
            const unlinkAttr = linkInfo.isManyToOne ? 'source.id' : 'target.id'
            const unlinkId = linkInfo.isManyToOne? sourceId: targetId
            const match = MatchExpression.createFromAtom({
                key: unlinkAttr,
                value: ['=', unlinkId]
            })
            await this.unlink(linkName, match)
        }

        const newLinkData = new NewRecordData(this.map, linkInfo.name, {
            source: {id: sourceId},
            target: {id: targetId},
            ...attributes
        })

        return this.createRecord(newLinkData)
    }


    async unlink(linkName: string, matchExpressionData: MatchExpressionData, moveSource = false) {
        const linkInfo = this.map.getLinkInfoByName(linkName)
        assert(!linkInfo.isTargetReliance, `cannot unlink reliance data, you can only delete record, ${linkName}`)

        const toMoveRecordInfo = moveSource ? linkInfo.sourceRecordInfo : linkInfo.targetRecordInfo
        const toMove = moveSource  ? 'source': 'target'
        if (linkInfo.isCombined()) {
            // 根据 Keep 决定是  source 还是 target 换位置
            const records = await this.findRecords(RecordQuery.create(linkName, this.map, {
                matchExpression: matchExpressionData,
                attributeQuery: [
                    ['source', {attributeQuery: ['id']}],
                    ['target', {attributeQuery: ['id']}]
                ]
            }))

            const toMoveIds = []
            for(let record of records) {
                if( record[toMove].id ) {
                    toMoveIds.push(record[toMove].id)
                }
            }


            // 除了当前 link 以外，所有和 toMove 相关的
            if (toMoveIds.length) {
                await this.moveRecords(
                    toMoveRecordInfo.name,
                    MatchExpression.createFromAtom({
                        key: 'id',
                        value: ['in', toMoveIds]
                    }),
                    [linkName]
                )
            }

            return
        }

        if (!linkInfo.isMerged()) {
            // 完全独立，直接删除符合条件的 就行了
            return this.deleteRecord(linkName, matchExpressionData)
        }


        // 剩下的都是 merge 到某一边的
        const records = await this.findRecords(RecordQuery.create(linkName, this.map, {
            matchExpression: matchExpressionData,
            attributeQuery: [
                ['source', {attributeQuery: ['id']}],
                ['target', {attributeQuery: ['id']}]
            ]
        }))

        if (records.length) {
            const recordName = linkInfo.isMergedToSource() ? linkInfo.sourceRecord : linkInfo.targetRecord
            const toUnlinkIds = records.map(record => linkInfo.isMergedToSource() ? record.source.id : record.target.id)
            const newMatch = MatchExpression.createFromAtom({
                key: 'id',
                value: ['in', toUnlinkIds]
            })

            const attributeName = linkInfo.isMergedToSource() ? linkInfo.sourceAttribute : linkInfo.targetAttribute!
            const newData = new NewRecordData(this.map, recordName, {[attributeName]: null} )

            return await this.updateRecord(recordName, newMatch, newData)
        }

    }
    // 默认会把连带的都移走
    async moveRecords(recordName:string, matchExpressionData: MatchExpressionData, excludeLinks: string[] = []) {
        const recordInfo = this.map.getRecordInfo(recordName)
        const includeRelated = recordInfo.combinedRecords.filter(info => {
            return !excludeLinks.includes(info.linkName)
        }).map(info => info.attributeName)

        // 所有 1:1 连带数据都要取出。始终只带出同表数据！！！！
        const records = await this.flashOutRecords(recordName, matchExpressionData, includeRelated)

        const newIds = []
        for( let record of records) {
            newIds.push(await this.createRecord(new NewRecordData(this.map, recordName, record)))
        }
        return newIds
    }
    async flashOutRecords(recordName:string, matchExpressionData: MatchExpressionData, includeRelated: string[] = []) {
        const records = await this.findRecords(RecordQuery.create(recordName, this.map, {
            matchExpression: matchExpressionData,
            // 所有关联数据。fields
            attributeQuery: this.constructAttributeQueryTree(recordName, includeRelated)
        }))


        // 删除老的
        if (records.length) {
            const ids = records.map(r => r.id)
            await this.deleteRecord(recordName, MatchExpression.createFromAtom({
                key: 'id',
                value: ['in', ids]
            }), includeRelated)
        }


        return records
    }
    // FIXME 还有关联的 relation 的 attribute
    constructAttributeQueryTree(recordName:string, includeAttributes: string[] = []) {
        const recordInfo = this.map.getRecordInfo(recordName)
        const valueAttributes: AttributeQueryDataItem[] = recordInfo.valueAttributes.map(info => info.attributeName)
        const relatedCombinedInfos = includeAttributes.map(r => {
            return recordInfo.getAttributeInfo(r)
        })
        const relatedRecordsAttributeQuery: AttributeQueryDataItem[] = relatedCombinedInfos.map(info => {
            const linkName = info.getLinkInfo().name
            const subRecordInfo = info.getRecordInfo()
            // CAUTION 一定要排除当前的，不然死循环了
            const subRelatedAttributes = subRecordInfo.combinedRecords.filter(subInfo => {
                return subInfo.linkName !== linkName
            }).map(subInfo => subInfo.attributeName)

            return [info.attributeName, {
                attributeQuery: this.constructAttributeQueryTree(info.getRecordInfo().name, subRelatedAttributes)
            }] as AttributeQueryDataItem
        })

        return valueAttributes.concat(relatedRecordsAttributeQuery)
    }
}



export class EntityQueryHandle {
    agent: QueryAgent

    constructor(public map: EntityToTableMap, public database: Database) {
        this.agent = new QueryAgent(map, database)
    }

    async findOne(entityName: string, matchExpression: MatchExpressionData, modifier: ModifierData = {}, attributeQuery?: AttributeQueryData) {
        const limitedModifier = {
            ...modifier,
            limit: 1
        }

        return (await this.find(entityName, matchExpression, limitedModifier, attributeQuery))[0]
    }

    async find(entityName: string, matchExpressionData?: MatchExpressionData, modifierData?: ModifierData, attributeQueryData: AttributeQueryData = []) {
        assert(this.map.getRecord(entityName), `cannot find entity ${entityName}`)
        const entityQuery = RecordQuery.create(
            entityName,
            this.map,
            {
                matchExpression: matchExpressionData,
                attributeQuery: attributeQueryData,
                modifier: modifierData
            },
        )

        return this.agent.findRecords(entityQuery)
    }

    async create(entityName: string, rawData: RawEntityData ) : Promise<EntityIdRef>{
        const newEntityData = new NewRecordData(this.map, entityName, rawData)
        return this.agent.createRecord(newEntityData)
    }
    // CAUTION 不能递归更新 relate entity 的 value，如果传入了 related entity 的值，说明是建立新的联系。
    async update(entity: string, matchExpressionData: MatchExpressionData, rawData: RawEntityData) {
        const newEntityData = new NewRecordData(this.map, entity, rawData)
        return this.agent.updateRecord(entity, matchExpressionData, newEntityData)
    }

    async delete(entityName: string, matchExpressionData: MatchExpressionData, ) {
        return this.agent.deleteRecord(entityName, matchExpressionData)
    }

    async addRelationByNameById(relationName: string, sourceEntityId: string,  targetEntityId:string, rawData: RawEntityData = {}) {
        assert(!!relationName && !!sourceEntityId && targetEntityId!!, `${relationName} ${sourceEntityId} ${targetEntityId} cannot be empty`)
        return this.agent.addLink(relationName, sourceEntityId, targetEntityId, rawData)
    }
    async addRelationById(entity:string, attribute:string, entityId: string, attributeEntityId:string, relationData?: RawEntityData) {
        return this.agent.addLinkFromRecord(entity, attribute, entityId, attributeEntityId, relationData)
    }
    async updateRelationByName(relationName:string, matchExpressionData: MatchExpressionData, rawData: RawEntityData) {
        assert(!rawData.source && !rawData.target, 'Relation can only update attributes. Use addRelation/removeRelation to update source/target.')
        return this.agent.updateRecord(relationName, matchExpressionData, new NewRecordData(this.map, relationName, rawData))
    }
    async findRelationByName(relationName: string, matchExpressionData?: MatchExpressionData, modifierData?: ModifierData, attributeQueryData: AttributeQueryData = []) {
        return this.find(relationName, matchExpressionData, modifierData, attributeQueryData)
    }
    async findOneRelationByName(relationName: string, matchExpressionData: MatchExpressionData, modifierData: ModifierData = {}, attributeQueryData: AttributeQueryData = []) {
        const limitedModifier = {
            ...modifierData,
            limit: 1
        }

        return (await this.findRelationByName(relationName, matchExpressionData, limitedModifier, attributeQueryData))[0]
    }

    createMatchFromAtom(...arg: Parameters<MatchExpression["createFromAtom"]>) {
        return MatchExpression.createFromAtom(...arg)
    }
    async removeRelationByName(relationName: string, matchExpressionData: MatchExpressionData) {
        return this.agent.unlink(relationName, matchExpressionData)
    }
    getRelationName(entity:string, attribute): string {
        return this.map.getInfo(entity, attribute).linkName
    }
}

