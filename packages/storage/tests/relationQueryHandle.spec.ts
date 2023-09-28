import {EntityQueryHandle, MatchExpression} from "../erstorage/ERStorage";
import {expect, test, describe, afterEach, beforeAll, beforeEach} from "bun:test";
import { createCommonData} from "./data/common";
import {DBSetup} from "../erstorage/Setup";
import { SQLiteDB } from '../../runtime/BunSQLite'
import {EntityToTableMap} from "../erstorage/EntityToTableMap";
import {removeAllInstance} from '../../shared/createClass'
import exp from "constants";


describe('find relation', () => {
    let db: SQLiteDB
    let setup
    let entityQueryHandle: EntityQueryHandle

    beforeEach(async () => {
        removeAllInstance()
        const { entities, relations } = createCommonData()
        // @ts-ignore
        db = new SQLiteDB(':memory:', {create:true, readwrite: true})
        setup = new DBSetup(entities, relations, db)
        await setup.createTables()
        entityQueryHandle = new EntityQueryHandle(new EntityToTableMap(setup.map), db)
    })

    afterEach(async () => {
        // CAUTION 因为是 memory, 所以会清空数据。如果之后测试改成实体数据库，那么要主动清空数据
        await db.close()
    })

    test('find 1:1 relation', async () => {
        await entityQueryHandle.create('User', {name: 'aaa', age: 17, profile: {title: 'aaa-profile'}})
        const result = await entityQueryHandle.findRelation(['User', 'profile'], undefined, {}, [['source', { attributeQuery: ['title']}], ['target', {attributeQuery: ['name']}]])
        expect(result.length).toBe(1)
        expect(result[0].source.title).toBe('aaa-profile')
        expect(result[0].target.name).toBe('aaa')

        const match1 = MatchExpression.createFromAtom({
            key: 'source.title',
            value: ['=', 'xxx']
        })
        const result1 = await entityQueryHandle.findRelation(['User', 'profile'], match1, {}, [['source', { attributeQuery: ['title']}], ['target', {attributeQuery: ['name']}]])
        expect(result1.length).toBe(0)

        const match2 = MatchExpression.createFromAtom({
            key: 'source.title',
            value: ['=', 'aaa-profile']
        })
        const result2 = await entityQueryHandle.findRelation(['User', 'profile'], match2, {}, [['source', { attributeQuery: ['title']}], ['target', {attributeQuery: ['name']}]])
        expect(result2.length).toBe(1)
    })


    test('create and query with 1:n related entities', async () => {
        const user = await entityQueryHandle.create('User', {name: 'aaa', age: 17 })
        const file1 = await entityQueryHandle.create('File', {fileName: 'file1', owner: user })
        const file2 = await entityQueryHandle.create('File', {fileName: 'file2', owner: user })

        const match1 = MatchExpression.createFromAtom({
            key: 'target.name',
            value: ['=', 'aaa']
        })
        const result1 = await entityQueryHandle.findRelation(['User', 'file'], match1, {}, [['source', { attributeQuery: ['fileName']}], ['target', {attributeQuery: ['name']}]])

        expect( result1.length).toBe(2)
        expect( result1[0].source.fileName).toBe('file1')
        expect( result1[0].target.name).toBe('aaa')
        expect( result1[1].source.fileName).toBe('file2')
        expect( result1[1].target.name).toBe('aaa')

        const match2 = MatchExpression.createFromAtom({
            key: 'target.name',
            value: ['=', 'aaa']
        }).and({
            key: 'source.fileName',
            value: ['=', 'file1']
        })

        await entityQueryHandle.removeRelation(['User', 'file'], match2)
        const result2 = await entityQueryHandle.findRelation(['User', 'file'], match1, {}, [['source', { attributeQuery: ['fileName']}], ['target', {attributeQuery: ['name']}]])
        expect( result2.length).toBe(1)
        expect( result2[0].source.fileName).toBe('file2')
        expect( result2[0].target.name).toBe('aaa')
    })



})
