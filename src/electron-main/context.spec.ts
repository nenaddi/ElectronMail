import path from "path";
import rewiremock from "rewiremock";
import sinon from "sinon";
import test from "ava";
import {Fs} from "fs-json-store";

test.serial(`"Context.db" resolves encryption key calling "Context.settingsStore.readExisting().databaseEncryptionKey"`, async (t) => {
    const memFsVolume = Fs.MemFs.volume();
    const memFsPath = process.cwd();

    memFsVolume._impl.mkdirpSync(memFsPath);

    const {initContext} = await rewiremock.around(
        () => import("./context"),
        (mock) => {
            mock(() => import("electron")).with({
                app: {getPath: sinon.stub().returns(memFsPath)},
            } as any);
            mock(() => import("./constants")).callThrough();
        },
    );
    const ctx = initContext({
        storeFs: memFsVolume,
    });

    await t.throwsAsync(
        ctx.db.options.encryption.keyResolver(),
        new RegExp(`${path.basename(ctx.settingsStore.file)} does not exist`),
    );

    const {databaseEncryptionKey} = await ctx.settingsStore.write(ctx.initialStores.settings);

    const readExistingSpy = sinon.spy(ctx.settingsStore, "readExisting");
    const resolvedDbKey1 = await ctx.db.options.encryption.keyResolver();
    const resolvedDbKey2 = await ctx.db.options.encryption.keyResolver();

    t.is(2, readExistingSpy.callCount);
    t.is(databaseEncryptionKey, resolvedDbKey1);
    t.is(databaseEncryptionKey, resolvedDbKey2);
});

test.serial([
    "db.options.encryption.keyResolver()",
    "initialSettings.databaseEncryptionKey",
    "settingsStore.databaseEncryptionKey",
].join(" == "), async (t) => {
    const memFsVolume = Fs.MemFs.volume();
    const memFsPath = process.cwd();

    memFsVolume._impl.mkdirpSync(memFsPath);

    const {INITIAL_STORES} = await import("./constants");
    const initialSettings = INITIAL_STORES.settings();
    const settingsStub = sinon.stub().returns(initialSettings);
    const {initContext} = await rewiremock.around(
        () => import("./context"),
        (mock) => {
            mock(() => import("electron")).with({
                app: {getPath: sinon.stub().returns(memFsPath)},
            } as any);
            mock(() => import("./constants")).callThrough().with({
                INITIAL_STORES: {
                    config: INITIAL_STORES.config,
                    settings: settingsStub,
                },
            });
        },
    );

    const ctx = initContext({
        storeFs: memFsVolume,
    });

    t.true(settingsStub.called, `"initContext()" should call "INITIAL_STORES.settings()" internally`);

    const {initApi} = await rewiremock.around(
        () => import("./api"),
        (mock) => {
            mock(() => import("electron")).with({
                app: {
                    on: sinon.stub()
                        .callsArg(1)
                        .withArgs("ready")
                        .callsArgWith(1, {}, {on: sinon.spy()}),
                },
            } as any);
            mock(() => import("src/electron-main/api/endpoints-builders")).callThrough().with({
                TrayIcon: {buildEndpoints: sinon.stub()},
            });
            mock(() => import("src/shared/api/main")).callThrough().with({
                IPC_MAIN_API: {register: sinon.stub()} as any,
            });
            mock(() => import("src/electron-main/window/full-text-search")).callThrough().with({
                attachFullTextIndexWindow: sinon.stub().returns(Promise.resolve()),
                detachFullTextIndexWindow: sinon.stub().returns(Promise.resolve()),
            });
        },
    );
    const {readSettings, readConfig} = await initApi(ctx);
    await readConfig();
    const {databaseEncryptionKey} = await readSettings({password: "password-123"});
    t.is(await ctx.db.options.encryption.keyResolver(), initialSettings.databaseEncryptionKey);
    t.is(await ctx.db.options.encryption.keyResolver(), databaseEncryptionKey);
});
