import { expect, test, describe } from "bun:test";
import {EntityToTableMap, MapData} from "../erstorage/EntityToTableMap";
import {entityToTableMapData} from "./data/mapData";
import {MatchExpression, MatchExpressionData} from "../erstorage/MatchExpression.ts";
import {RecordQueryTree} from "../erstorage/RecordQuery.ts";


const entityToTableMap = new EntityToTableMap(entityToTableMapData)

describe('match expression test', () => {
    test("basic match query", () => {

        const queryData:MatchExpressionData = MatchExpression.createFromAtom({
            key: 'leader.name',
            value: ['=', 'A']
        }).and({
            key: 'leader.profile.title',
            value: ['=' , 'classified']
        })

        const matchExpression = new MatchExpression('User', entityToTableMap , queryData)
        expect(matchExpression.entityQueryTree.records.leader).toBeInstanceOf(RecordQueryTree)
        expect(matchExpression.entityQueryTree.records.leader.records.profile).toBeInstanceOf(RecordQueryTree)
    });
})

