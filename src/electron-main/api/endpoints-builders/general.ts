import electronLog from "electron-log";
import {IpcMainApiActionContext, resolveIpcMainApiActionContext} from "electron-rpc-api";
import {app, shell} from "electron";
import {isWebUri} from "valid-url";
import {platform} from "os";
import {startWith} from "rxjs/operators";

import {Context} from "src/electron-main/model";
import {Endpoints, IPC_MAIN_API_NOTIFICATION_ACTIONS} from "src/shared/api/main";
import {IPC_MAIN_API_NOTIFICATION$} from "src/electron-main/api/constants";
import {showAboutBrowserWindow} from "src/electron-main/window/about";

type ApiMethods = keyof Pick<Endpoints,
    | "log"
    | "openAboutWindow"
    | "openExternal"
    | "openSettingsFolder"
    | "quit"
    | "activateBrowserWindow"
    | "toggleBrowserWindow"
    | "hotkey"
    | "selectAccount"
    | "notification">;

export async function buildEndpoints(ctx: Context): Promise<Pick<Endpoints, ApiMethods>> {
    const endpoints: Pick<Endpoints, ApiMethods> = {
        async log(lines) {
            for (const line of lines) {
                electronLog[line.level](...line.dataArgs);
            }
        },

        async openAboutWindow() {
            await showAboutBrowserWindow(ctx);
        },

        async openExternal({url}) {
            if (!isWebUri(url)) {
                throw new Error(`Forbidden url "${url}" opening has been prevented`);
            }

            await shell.openExternal(url, {activate: true});
        },

        async openSettingsFolder() {
            shell.openItem(ctx.locations.userDataDir);
        },

        async quit() {
            app.exit();
        },

        async activateBrowserWindow() {
            const {window} = await ctx.configStore.readExisting();
            const browserWindow = ctx.uiContext && ctx.uiContext.browserWindow;

            if (!browserWindow) {
                return;
            }

            if (window.maximized) {
                browserWindow.maximize();

                // above "maximize()" call is supposed to show the window, but sometimes it doesn't on some systems (especially macOS)
                if (!browserWindow.isVisible()) {
                    browserWindow.show();
                }
            } else {
                browserWindow.show();
            }

            browserWindow.focus();

            IPC_MAIN_API_NOTIFICATION$.next(IPC_MAIN_API_NOTIFICATION_ACTIONS.ActivateBrowserWindow());
        },

        async toggleBrowserWindow({forcedState}) {
            const browserWindow = ctx.uiContext && ctx.uiContext.browserWindow;

            if (!browserWindow) {
                return;
            }

            if (typeof forcedState !== "undefined" ? forcedState : !browserWindow.isVisible()) {
                await endpoints.activateBrowserWindow();
            } else {
                browserWindow.hide();
            }
        },

        async selectAccount(this: IpcMainApiActionContext, {databaseView, reset}) {
            const [{sender: webContents}] = resolveIpcMainApiActionContext(this).args;

            const prevSelectedAccount = ctx.selectedAccount;
            const newSelectedAccount = reset
                ? undefined
                : {
                    webContentId: webContents.id,
                    databaseView,
                };
            const needToCloseFindInPageWindow = (
                // reset - no accounts in the list
                !newSelectedAccount
                ||
                // TODO figure how to hide webview from search while in database view mode
                //      webview can't be detached from DOM as it gets reloaded when reattached
                //      search is not available in database view mode until then
                newSelectedAccount.databaseView
                ||
                // changed selected account
                prevSelectedAccount && prevSelectedAccount.webContentId !== newSelectedAccount.webContentId
            );

            if (needToCloseFindInPageWindow) {
                await (await ctx.deferredEndpoints.promise).findInPageStop();
                await (await ctx.deferredEndpoints.promise).findInPageDisplay({visible: false});
            }

            ctx.selectedAccount = newSelectedAccount;
        },

        async hotkey(this: IpcMainApiActionContext, {type}) {
            const [{sender: webContents}] = resolveIpcMainApiActionContext(this).args;

            if (platform() !== "darwin") {
                return;
            }

            switch (type) {
                case "copy":
                    webContents.copy();
                    break;
                case "paste":
                    webContents.paste();
                    break;
                case "selectAll":
                    webContents.selectAll();
                    break;
                default:
                    throw new Error(`Unknown hotkey "type" value:  "${type}"`);
            }
        },

        notification() {
            return IPC_MAIN_API_NOTIFICATION$.asObservable().pipe(
                startWith(IPC_MAIN_API_NOTIFICATION_ACTIONS.Bootstrap({})),
            );
        },
    };

    return endpoints;
}
