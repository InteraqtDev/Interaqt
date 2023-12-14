import {ComputedData, Entity, Interaction, KlassInstance, MapRecordMutation} from "@interaqt/shared";
import {Controller} from "../Controller.js";
import {ComputedDataHandle, DataContext} from "./ComputedDataHandle.js";
import {RecordMutationEvent} from "../System.js";
import {IncrementalComputedDataHandle, StatePatch} from "./IncrementalComputedDataHandle.js";

export class MapInteractionHandle extends IncrementalComputedDataHandle {
    data!: KlassInstance<typeof Entity, false>
    mapItem!: (mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]) => any
    computeTarget?: (mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]) => any
    constructor(controller: Controller , computedData: KlassInstance<typeof ComputedData, false> , dataContext:  DataContext) {
        super(controller, computedData, dataContext);
    }
    parseComputedData() {
        const computedData = this.computedData as unknown as  KlassInstance<typeof MapRecordMutation, false>
        this.data = this.dataContext.id as KlassInstance<typeof Entity, false>
        this.mapItem = (computedData.handle! as (mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]) => any ).bind(this.controller)
        this.computeTarget = computedData.computeTarget?.bind(this.controller)
    }
    computeEffect(mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]): any {
        return true
    }

    async computePatch(effect: any, lastValue: any, mutationEvent: RecordMutationEvent, mutationEvents: RecordMutationEvent[]): Promise<StatePatch | StatePatch[] | undefined> {
        const newValue = await this.mapItem.call(this.controller, mutationEvent, mutationEvents)
        if (this.computedDataType === 'global') {
            return {
                type: 'update',
                value: newValue
            }
        } else if(this.computedDataType === 'property'){
            const affected = await this.mapItem.call(this.controller, mutationEvent, mutationEvents)
            if (affected?.id) {
                return {
                    type: 'update',
                    value: newValue,
                    affectedId: affected.id
                }
            }

        } else if (this.computedDataType === 'entity' || this.computedDataType === 'relation') {
            if (newValue) {
                return {
                    type: newValue.id? 'update':'create',
                    value: newValue,
                    affectedId: newValue.id
                } as StatePatch
            }

        }
    }

}

ComputedDataHandle.Handles.set(MapRecordMutation, MapInteractionHandle)