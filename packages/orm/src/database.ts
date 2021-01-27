/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { ClassType, CustomError, getClassName } from '@deepkit/core';
import { Query } from './query';
import { getDatabaseSessionHydrator, isHydrated } from './formatter';
import { ClassSchema, getClassSchema, PrimaryKeyFields } from '@deepkit/type';
import { DatabaseSession } from './database-session';
import { QueryDatabaseEmitter, UnitOfWorkDatabaseEmitter } from './event';
import { Entity } from './type';
import { VirtualForeignKeyConstraint } from './virtual-foreign-key-constraint';
import { getNormalizedPrimaryKey } from './identity-map';
import { getReference } from './reference';
import { DatabaseAdapter } from './database-adapter';

/**
 * Hydrates not completely populated item and makes it completely accessible.
 */
export async function hydrateEntity<T>(item: T) {
    if (isHydrated(item)) {
        return await getDatabaseSessionHydrator(item)(item);
    }
    throw new Error(`Given object is not a proxy object and thus can not be hydrated, or is already hydrated.`);
}

export class DatabaseError extends CustomError {}

/**
 * Database abstraction. Use createSession() to create a work session with transaction support.
 *
 * Using this class in your code indicates that you can work with common and most basic database semantics.
 * This means that you can use the deepkit/type database API that works across a variety of database engines
 * like MySQL, PostgreSQL, SQLite, and MongoDB.
 */
export class Database<ADAPTER extends DatabaseAdapter = DatabaseAdapter> {
    public name: string = 'default';

    /**
     * The entity schema registry.
     */
    public readonly entities = new Set<ClassSchema>();

    /**
     * Event API for DatabaseQuery events.
     */
    public readonly queryEvents = new QueryDatabaseEmitter();

    /**
     * Event API for the unit of work.
     */
    public readonly unitOfWorkEvents = new UnitOfWorkDatabaseEmitter();

    /**
     * Creates a new DatabaseQuery instance which can be used to query data.
     *  - Entity instances ARE NOT cached or tracked.
     *
     * Use a DatabaseSession (createSession()) with its query() in your workflow to enable
     * identity map.
     * 
     * ```typescript
     * const session = database.createSession();
     * 
     * const item = await session.query(MyType).findOne();
     * item.name = 'changed';
     * session.commit(); //only necessary when you changed items received by this session
     * ```
     */
    public readonly query: ReturnType<this['adapter']['queryFactory']>['createQuery'];

    protected virtualForeignKeyConstraint: VirtualForeignKeyConstraint = new VirtualForeignKeyConstraint(this);

    constructor(
        public readonly adapter: ADAPTER,
        schemas: (ClassType | ClassSchema)[] = []
    ) {
        this.query = (classType: ClassType | ClassSchema) => {
            const session = this.createSession();
            session.withIdentityMap = false;
            return session.query(classType);
        };
        this.registerEntity(...schemas);

        if (!this.adapter.isNativeForeignKeyConstraintSupported()) {
            this.unitOfWorkEvents.onDeletePost.subscribe(async (event) => {
                await this.virtualForeignKeyConstraint.onUoWDelete(event);
            });
            this.unitOfWorkEvents.onUpdatePost.subscribe(async (event) => {
                await this.virtualForeignKeyConstraint.onUoWUpdate(event);
            });

            this.queryEvents.onPatchPost.subscribe(async (event) => {
                await this.virtualForeignKeyConstraint.onQueryPatch(event);
            });
            this.queryEvents.onDeletePost.subscribe(async (event) => {
                await this.virtualForeignKeyConstraint.onQueryDelete(event);
            });
        }
    }

    static createClass<T extends DatabaseAdapter>(name: string, adapter: T, schemas: (ClassType | ClassSchema)[] = []): ClassType<Database<T>> {
        return class extends Database<T> {
            constructor(oAdapter = adapter, oSchemas = schemas) {
                super(oAdapter, oSchemas);
                this.name = name;
            }
        };
    }

    /**
     * Tells the adapter to disconnect. It reconnects automatically when necessary.
     */
    disconnect(force?: boolean): void {
        this.adapter.disconnect(force);
    }

    /**
     * Creates a new database session. This is the preferred way of working with the database
     * and to enjoy all ORM features. Call DatabaseSession.commit to persist changes all at once
     * in the most performant way possible. The creation of a DatabaseSession is very low cost,
     * so creating many or often is the preferred way.
     **
     * All entity instances fetched/stored during this session are cached and tracked automatically.
     *
     * Note: This is not equal to a database transaction. A session means a work block
     * where you need to fetch, change, and save entity instances. Every instance fetched
     * stays in the identity-map of that session and keeps it alive, so make sure
     * to not keep a session for too long (especially not cross requests).

     * @example
     * ```typescript
     * const database = new Database(...);
     *
     * express.on('request', async (req) => {
     *     const session = database.createSession();
     *     const user = session.query(User).filter({id: req.params.id}).findOne();
     *     user.name = req.params.name;
     *     await session.commit(); //session will be garbage collected and should NOT be stored for the next request
     * });
     * ```
     */
    public createSession(): DatabaseSession<ADAPTER> {
        return new DatabaseSession(this.adapter, this.unitOfWorkEvents, this.queryEvents);
    }

    /**
     * Executes given callback in a new session and automatically commits it when executed successfully.
     * Automatically does a rollback when callback throws an error. This has the same semantics as `createSession`.
     */
    public async session<T>(worker: (session: DatabaseSession<ADAPTER>) => Promise<T>): Promise<T> {
        const session = this.createSession();
        const res = await worker(session);
        await session.commit();
        return res;
    }

    /**
     * Creates a new reference.
     * 
     * If you work with a DatabaseSession, use DatabaseSession.getReference instead to
     * maintain object identity.
     *
     * ```
     * const user = database.getReference(User, 1);
     * ```
     */
    public getReference<T>(classType: ClassType<T> | ClassSchema<T>, primaryKey: any | PrimaryKeyFields<T>): T {
        const schema = getClassSchema(classType);
        const pk = getNormalizedPrimaryKey(schema, primaryKey);
        return getReference(schema, pk);
    }

    /**
     * Registers a new entity to this database.
     * This is mainly used for db migration utilities and active record.
     * If you want to use active record, you have to assign your entities first to a database using this method.
     */
    registerEntity(...entities: (ClassType | ClassSchema)[]): void {
        for (const entity of entities) {
            const schema = getClassSchema(entity);

            this.entities.add(schema);

            schema.data['orm.database'] = this;
            if (isActiveRecordClassType(entity)) entity.registerDatabase(this);
        }
    }

    /**
     * Makes sure the schemas types, indices, uniques, etc are reflected in the database.
     *
     * WARNING: DON'T USE THIS IN PRODUCTION AS THIS CAN CAUSE EASILY DATA LOSS.
     * SEE THE MIGRATION DOCUMENTATION TO UNDERSTAND ITS IMPLICATIONS.
     */
    async migrate() {
        await this.adapter.migrate([...this.entities.values()]);
    }

    /**
     * Simple direct persist. The persistence layer (batch) inserts or updates the record
     * depending on the state of the given items. This is different to createSession()+add() in a way
     * that `DatabaseSession.add` adds the given items to the queue (which is then committed using commit())
     * while this `database.persist` just simply inserts/updates the given items immediately,
     * completely bypassing the advantages of the unit of work for multiple items.
     *
     * You should prefer the add/remove and commit() workflow to fully utilizing database performance.
     */
    public async persist<T extends Entity>(...items: T[]) {
        const session = this.createSession();
        session.add(...items);
        await session.commit();
    }

    /**
     * Simple direct remove. The persistence layer (batch) removes all given items.
     * This is different to createSession()+remove() in a way that `DatabaseSession.remove` adds the given items to the queue
     * (which is then committed using commit()) while this `database.remove` just simply removes the given items immediately,
     * completely bypassing the advantages of the unit of work for multiple items.
     *
     * You should prefer the add/remove and commit() workflow to fully utilizing database performance.
     */
    public async remove<T extends Entity>(...items: T[]) {
        const session = this.createSession();
        session.remove(...items);
        await session.commit();
    }
}

export interface ActiveRecordClassType {
    new(...args: any[]): ActiveRecord;

    getDatabase(): Database<any>;

    registerDatabase(database: Database<any>): void;

    query(): any;
}

export function isActiveRecordClassType(entity: any): entity is ActiveRecordClassType {
    return 'function' === entity.getDatabase || 'function' === entity.registerDatabase || 'function' === entity.query;
}

export class ActiveRecord {
    constructor(...args: any[]) { }

    public static getDatabase(): Database<any> {
        const database = getClassSchema(this).data['orm.database'] as Database<any> | undefined;
        if (!database) throw new Error(`No database assigned to ${getClassName(this)}. Use Database.registerEntity(${getClassName(this)}) first.`);
        return database;
    }

    public static registerDatabase(database: Database<any>): void {
        getClassSchema(this).data['orm.database'] = database;
    }

    public async save(): Promise<void> {
        const db = ((this as any).constructor as ActiveRecordClassType).getDatabase();
        await db.persist(this);
    }

    public async remove(): Promise<void> {
        const db = ((this as any).constructor as ActiveRecordClassType).getDatabase();
        await db.remove(this);
    }

    public static query<T extends typeof ActiveRecord>(this: T): Query<InstanceType<T>> {
        return this.getDatabase().query(this);
    }

    public static reference<T extends typeof ActiveRecord>(this: T, primaryKey: any | PrimaryKeyFields<InstanceType<T>>): InstanceType<T> {
        return this.getDatabase().getReference(this, primaryKey) as InstanceType<T>;
    }
}
