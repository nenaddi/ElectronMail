import electronLog from "electron-log";
import {webContents as ElectronWebContents} from "electron";
import {Subject, of} from "rxjs";
import {startWith} from "rxjs/operators";

import {Context} from "src/electron-main/model";
import {Endpoints, EndpointsScan} from "src/shared/api/main";
import {curryFunctionMembers} from "src/shared/util";
import {initFindInPageBrowserView} from "src/electron-main/window/find-in-page";

type ApiMethods = keyof Pick<Endpoints,
    | "findInPageDisplay"
    | "findInPage"
    | "findInPageStop"
    | "findInPageNotification">;

type Notification = EndpointsScan["ApiReturns"]["findInPageNotification"];

interface NotificationMapValue {
    readonly subject: Subject<Notification>;
    readonly reset: () => void;
}

const _logger = curryFunctionMembers(electronLog, "[electron-main/api/endpoints-builders/find-in-page]");

export async function buildEndpoints(ctx: Context): Promise<Pick<Endpoints, ApiMethods>> {
    let findInPageNotification: NotificationMapValue | null = null;

    const resolveContext = () => {
        if (!ctx.uiContext) {
            throw new Error(`UI Context has not been initialized`);
        }
        return ctx.uiContext;
    };

    const endpoints: Pick<Endpoints, ApiMethods> = {
        async findInPageDisplay({visible}) {
            const logger = curryFunctionMembers(_logger, "findInPageDisplay()");

            logger.info();

            if (visible) {
                if (!ctx.selectedAccount) {
                    logger.warn(`skipping as "ctx.selectedAccount" undefined`);
                    return;
                }

                if (ctx.selectedAccount.databaseView) {
                    // TODO figure how to hide webview from search while in database view mode
                    //      webview can't be detached from DOM as it gets reloaded when reattached
                    //      search is not available in database view mode until then
                    logger.warn(`skipping as "ctx.selectedAccount.databaseView" positive value`);
                    return;
                }

                const {findInPage} = await (await ctx.deferredEndpoints.promise).readConfig();

                if (!findInPage) {
                    logger.debug(`skipping as "findInPage" config option disabled`);
                    return;
                }
            }

            const uiContext = resolveContext();
            const {browserWindow} = uiContext;

            if (visible) {
                if (!uiContext.findInPageBrowserView || uiContext.findInPageBrowserView.isDestroyed()) {
                    logger.verbose(`building new "uiContext.findInPageBrowserView" instance`);
                    const view = uiContext.findInPageBrowserView = await initFindInPageBrowserView(ctx);
                    setTimeout(() => view.webContents.focus());
                } else {
                    logger.debug(`skipping building new "uiContext.findInPageBrowserView" instance as existing one is still alive`);
                }
            } else {
                // reset/complete the notification
                if (findInPageNotification) {
                    logger.verbose(`destroying "findInPageNotification"`);
                    findInPageNotification.reset();
                    findInPageNotification = null;
                }

                // WARN: "findInPageBrowserView.webContents" is needed to send API response
                // so we don't destroy it immediately but with timeout letting API respond to request first
                setTimeout(() => {
                    if (!uiContext.findInPageBrowserView) {
                        logger.debug(`skipping destroying as "uiContext.findInPageBrowserView" undefined`);
                        return;
                    }

                    // destroy
                    logger.verbose(`destroying "uiContext.findInPageBrowserView"`);
                    // WARN "setBrowserView" needs to be called with null, see https://github.com/electron/electron/issues/13581
                    // TODO TS: get rid of any cast, see https://github.com/electron/electron/issues/13581
                    browserWindow.setBrowserView(null as any);
                    uiContext.findInPageBrowserView.destroy();
                    delete uiContext.findInPageBrowserView;
                });

                if (uiContext.findInPageBrowserView) {
                    browserWindow.webContents.focus();
                }
            }
        },

        async findInPage({query, options}) {
            if (!ctx.selectedAccount) {
                return null;
            }

            const webContents = ElectronWebContents.fromId(ctx.selectedAccount.webContentId);
            const requestId = webContents.findInPage(query, options);

            return {requestId};
        },

        async findInPageStop() {
            ElectronWebContents
                .getAllWebContents()
                .forEach((webContents) => webContents.stopFindInPage("clearSelection"));
        },

        findInPageNotification() {
            if (findInPageNotification) {
                findInPageNotification.reset();
                findInPageNotification = null;
            }

            if (!ctx.selectedAccount) {
                return of({requestId: null});
            }

            const webContents = ElectronWebContents.fromId(ctx.selectedAccount.webContentId);
            const notificationSubject = new Subject<Notification>();
            const notificationReset = (() => {
                const eventSubscriptionArgs: ["found-in-page", (event: Electron.Event, result: Electron.FoundInPageResult) => void] = [
                    "found-in-page",
                    (...args) => {
                        const [, result] = args;
                        if (!webContents.isDestroyed()) {
                            notificationSubject.next(result);
                        }
                    },
                ];

                webContents.addListener(...eventSubscriptionArgs);

                return () => {
                    if (webContents.isDestroyed()) {
                        return;
                    }
                    notificationSubject.complete();
                    webContents.removeListener(...eventSubscriptionArgs);
                };
            })();

            findInPageNotification = {subject: notificationSubject, reset: notificationReset};

            return notificationSubject.asObservable().pipe(
                // initial/fake response resets the timeout
                startWith({requestId: null}),
            );
        },
    };

    return endpoints;
}
