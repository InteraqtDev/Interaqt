import {RecordMutationEvent} from "../System";
import {IncrementalComputedDataHandle, StatePatch} from "./IncrementalComputedDataHandle";
import {KlassInstance} from "@shared/createClass";
import {Entity, Relation} from "@shared/entity/Entity";
import {WeightedSummation} from "@shared/IncrementalComputation";
import {MatchExp} from '@storage/erstorage/MatchExp'
import {ComputedDataHandle} from "./ComputedDataHandle";

type RecordChangeEffect = {
    affectedId: string,
    recordName: string
    info: KlassInstance<any, false>
}

export class WeightedSummationHandle extends IncrementalComputedDataHandle {
    records: KlassInstance<typeof WeightedSummation, false>['records'] = []
    mapRelationToWeight: (record: KlassInstance<typeof Entity, false> | KlassInstance<typeof Relation, false>, info: KlassInstance<any, false>) => number = () => 0
    // 单独抽出来让下面能覆写
    parseComputedData(){
        const computedData = this.computedData as unknown as KlassInstance<typeof WeightedSummation, false>
        this.mapRelationToWeight = this.parseMapRelationFunction(computedData.matchRecordToWeight!).bind(this.controller)
        this.records = computedData.records
    }
    getDefaultValue(newRecordId?: any): any {
        return 0
    }
    parseMapRelationFunction(stringContent:string) {
        return new Function('record', `return (${stringContent})(record)`)
    }
    async computeEffect(mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]): Promise<KlassInstance<any, false>|undefined> {
        return this.records!.find((record) => {
            return (record.name) === mutationEvent.recordName
        })
    }
    async getLastValue(effect: RecordChangeEffect, mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]) {
        return this.controller.system.storage.get('state', this.stateName!)
    }
    async computePatch(effect: KlassInstance<any, false>, lastSummation: number, mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]): Promise<StatePatch|StatePatch[]|undefined> {
        let currentWeight = 0
        let originWeight = 0

        let currentRecord
        let oldRecord


        const isRelation = effect instanceof Relation
        const affectedId = mutationEvent.record?.id ?? mutationEvent.oldRecord?.id
        const recordName = mutationEvent.recordName

        if (mutationEvent.type === 'create' || mutationEvent.type === 'update') {
            const match = MatchExp.atom({key: 'id', value: ['=', affectedId]})
            currentRecord = isRelation ? await this.controller.system.storage.findOneRelationByName(recordName!, match, undefined, ['*'])
                : await this.controller.system.storage.findOne(recordName!, match, undefined, ['*'])
        }

        if (mutationEvent.type === 'update') {
            oldRecord = mutationEvent.oldRecord!
        }

        if (mutationEvent.type === 'delete') {
            oldRecord = mutationEvent.record!
        }

        if (currentRecord) {
            currentWeight = this.mapRelationToWeight(currentRecord, effect )
        }

        if (oldRecord) {
            originWeight = this.mapRelationToWeight(oldRecord as KlassInstance<typeof Entity, false>, effect)
        }

        if(currentWeight !== originWeight) {
            // FIXME 改成引用的形式, 例如 “+1” 这样就不用获取上一次的值了 ？storage 要支持，现在好像不支持？？？
            return {
                type: 'update',
                affectedId,
                value: lastSummation + (currentWeight - originWeight)
            }
        }
    }
}

ComputedDataHandle.Handles.set(WeightedSummation, WeightedSummationHandle)