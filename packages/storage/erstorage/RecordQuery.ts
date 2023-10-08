import {MatchExpression, MatchExpressionData} from "./MatchExpression";
import {AttributeQuery, AttributeQueryData} from "./AttributeQuery";
import {Modifier, ModifierData} from "./Modifier";
import {EntityToTableMap} from "./EntityToTableMap";
import {AttributeInfo} from "./AttributeInfo.ts";

export type RecordQueryData = {
    matchExpression?: MatchExpressionData,
    attributeQuery?: AttributeQueryData,
    modifier?: ModifierData
}


export class RecordQuery {
    static create(recordName: string, map: EntityToTableMap, data: RecordQueryData, contextRootEntity?: string, parentRecord?:string, attributeName?:string) {
        // CAUTION 因为合表后可能用关联数据匹配到行。
        const matchExpression = (new MatchExpression(recordName, map, data.matchExpression, contextRootEntity)).and({
            key: 'id',
            value: ['not', null]
        })
        return new RecordQuery(
            recordName,
            map,
            matchExpression,
            // new MatchExpression(recordName, map, data.matchExpression, contextRootEntity),
            new AttributeQuery(recordName, map, data.attributeQuery || [], parentRecord, attributeName),
            new Modifier(recordName, map, data.modifier!),
            contextRootEntity,
        )
    }
    constructor(public recordName: string, public map: EntityToTableMap, public matchExpression: MatchExpression, public attributeQuery: AttributeQuery, public modifier: Modifier, public contextRootEntity?: string) {}
}


export class RecordQueryTree {
    public fields: string[] =[]
    public records: {[k:string]: RecordQueryTree} = {}
    public info? :AttributeInfo
    constructor(public recordName: string, public map: EntityToTableMap, public parentRecord?:string, public attributeName?: string, data?: {fields: string[], records: {[k:string]: RecordQueryTree}}) {
        if (data){
            this.fields = data.fields || []
            this.records = data.records || {}
        }
        if (parentRecord) {
            this.info = new AttributeInfo(this.parentRecord, this.attributeName, this.map)
        }
    }
    addField(namePath:string[]) {
        const [name, ...rest] = namePath
        if (namePath.length === 1) {
            this.fields.push(name)
        } else {
            const info = this.map.getInfo(this.recordName, name)
            if (!this.records[name]) this.records[name] = new RecordQueryTree(info.recordName, this.map, this.recordName, name)
            this.records[name].addField(rest)
        }
    }
    addRecord(namePath: string[], subTree?: RecordQueryTree) {
        const [name, ...rest] = namePath
        if (namePath.length === 1) {
            const info = this.map.getInfo(this.recordName, name)
            this.records[name] = subTree || new RecordQueryTree(info.recordName, this.map, this.recordName, name)
        } else {
            this.records[name].addRecord(rest, subTree)
        }
    }
    forEachRecords(handle: (t:RecordQueryTree) => any) {
        Object.values(this.records).forEach(r => handle(r))
    }
    onlyIdField() {
        return this.fields.length === 1 && this.fields[0] === 'id'
    }
    merge(otherTree:RecordQueryTree) {
        const fields = Array.from(new Set([...this.fields, ...otherTree.fields]))
        const records = {}
        const keys = Array.from(new Set([...Object.keys(this.records), ...Object.keys(otherTree.records)]))
        keys.forEach(key => {
            if (this.records[key] && otherTree.records[key]) {
                records[key] = this.records[key].merge(otherTree.records[key])
            } else if (this.records[key]) {
                records[key] = this.records[key]
            } else {
                records[key] = otherTree.records[key]
            }
        })

        return new RecordQueryTree(this.recordName, this.map, this.parentRecord, this.attributeName, { fields, records})
    }
}

// export type RecordQueryTree = {
//     _fields?: string[],
//     [k: string]: RecordQueryTree
// }