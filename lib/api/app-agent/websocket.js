import Emittery from "emittery";
import { omit } from "lodash-es";
import { getLauncherEnvironment } from "../../environments/launcher.js";
import { getBaseRoleNameFromCloneId, isCloneId } from "../common.js";
import { AppWebsocket, CellType, } from "../index.js";
/**
 * A class to establish a websocket connection to an App interface, for a
 * specific agent and app.
 *
 * @public
 */
export class AppAgentWebsocket {
    appWebsocket;
    installedAppId;
    cachedAppInfo;
    myPubKey;
    emitter;
    constructor(appWebsocket, installedAppId, myPubKey) {
        this.appWebsocket = appWebsocket;
        this.emitter = new Emittery();
        const env = getLauncherEnvironment();
        this.installedAppId = env?.INSTALLED_APP_ID || installedAppId;
        this.myPubKey = myPubKey;
        this.appWebsocket.on("signal", (signal) => {
            if (this.containsCell(signal.cell_id)) {
                this.emitter.emit("signal", signal);
            }
        });
    }
    /**
     * Request the app's info, including all cell infos.
     *
     * @returns The app's {@link AppInfo}.
     */
    async appInfo() {
        const appInfo = await this.appWebsocket.appInfo({
            installed_app_id: this.installedAppId,
        });
        this.cachedAppInfo = appInfo;
        return appInfo;
    }
    /**
     * Instance factory for creating AppAgentWebsockets.
     *
     * @param url - The `ws://` URL of the App API to connect to.
     * @param installed_app_id - ID of the App to link to.
     * @param defaultTimeout - Timeout to default to for all operations.
     * @returns A new instance of an AppAgentWebsocket.
     */
    static async connect(url, installed_app_id, defaultTimeout) {
        const appWebsocket = await AppWebsocket.connect(url, defaultTimeout);
        const appInfo = await appWebsocket.appInfo({
            installed_app_id: installed_app_id,
        });
        const appAgentWs = new AppAgentWebsocket(appWebsocket, installed_app_id, appInfo.agent_pub_key);
        appAgentWs.cachedAppInfo = appInfo;
        return appAgentWs;
    }
    /**
     * Get a cell id by its role name or clone id.
     *
     * @param roleName - The role name or clone id of the cell.
     * @param appInfo - The app info containing all cell infos.
     * @returns The cell id or throws an error if not found.
     */
    getCellIdFromRoleName(roleName, appInfo) {
        if (isCloneId(roleName)) {
            const baseRoleName = getBaseRoleNameFromCloneId(roleName);
            if (!(baseRoleName in appInfo.cell_info)) {
                throw new Error(`No cell found with role_name ${roleName}`);
            }
            const cloneCell = appInfo.cell_info[baseRoleName].find((c) => CellType.Cloned in c && c[CellType.Cloned].clone_id === roleName);
            if (!cloneCell || !(CellType.Cloned in cloneCell)) {
                throw new Error(`No clone cell found with clone id ${roleName}`);
            }
            return cloneCell[CellType.Cloned].cell_id;
        }
        if (!(roleName in appInfo.cell_info)) {
            throw new Error(`No cell found with role_name ${roleName}`);
        }
        const cell = appInfo.cell_info[roleName].find((c) => CellType.Provisioned in c);
        if (!cell || !(CellType.Provisioned in cell)) {
            throw new Error(`No provisioned cell found with role_name ${roleName}`);
        }
        return cell[CellType.Provisioned].cell_id;
    }
    /**
     * Call a zome.
     *
     * @param request - The zome call arguments.
     * @param timeout - A timeout to override the default.
     * @returns The zome call's response.
     */
    async callZome(request, timeout) {
        if ("provenance" in request) {
            if ("role_name" in request && request.role_name) {
                throw new Error("Cannot find other agent's cells based on role name. Use cell id when providing a provenance.");
            }
        }
        else {
            request = {
                ...request,
                provenance: this.myPubKey,
            };
        }
        if ("role_name" in request && request.role_name) {
            const appInfo = this.cachedAppInfo || (await this.appInfo());
            const cell_id = this.getCellIdFromRoleName(request.role_name, appInfo);
            const zomeCallPayload = {
                ...omit(request, "role_name"),
                provenance: this.myPubKey,
                cell_id,
            };
            return this.appWebsocket.callZome(zomeCallPayload, timeout);
        }
        else if ("cell_id" in request && request.cell_id) {
            return this.appWebsocket.callZome(request, timeout);
        }
        throw new Error("callZome requires a role_name or cell_id arg");
    }
    /**
     * Clone an existing provisioned cell.
     *
     * @param args - Specify the cell to clone.
     * @returns The created clone cell.
     */
    async createCloneCell(args) {
        const clonedCell = this.appWebsocket.createCloneCell({
            app_id: this.installedAppId,
            ...args,
        });
        this.cachedAppInfo = undefined;
        return clonedCell;
    }
    /**
     * Enable a disabled clone cell.
     *
     * @param args - Specify the clone cell to enable.
     * @returns The enabled clone cell.
     */
    async enableCloneCell(args) {
        return this.appWebsocket.enableCloneCell({
            app_id: this.installedAppId,
            ...args,
        });
    }
    /**
     * Disable an enabled clone cell.
     *
     * @param args - Specify the clone cell to disable.
     */
    async disableCloneCell(args) {
        return this.appWebsocket.disableCloneCell({
            app_id: this.installedAppId,
            ...args,
        });
    }
    /**
     * Register an event listener for signals.
     *
     * @param eventName - Event name to listen to (currently only "signal").
     * @param listener - The function to call when event is triggered.
     * @returns A function to unsubscribe the event listener.
     */
    on(eventName, listener) {
        return this.emitter.on(eventName, listener);
    }
    containsCell(cellId) {
        const appInfo = this.cachedAppInfo;
        if (!appInfo) {
            return false;
        }
        for (const roleName of Object.keys(appInfo.cell_info)) {
            for (const cellInfo of appInfo.cell_info[roleName]) {
                const currentCellId = CellType.Provisioned in cellInfo
                    ? cellInfo[CellType.Provisioned].cell_id
                    : CellType.Cloned in cellInfo
                        ? cellInfo[CellType.Cloned].cell_id
                        : undefined;
                if (currentCellId && isSameCell(currentCellId, cellId)) {
                    return true;
                }
            }
        }
        return false;
    }
}
const isSameCell = (cellId1, cellId2) => cellId1[0].every((byte, index) => byte === cellId2[0][index]) &&
    cellId1[1].every((byte, index) => byte === cellId2[1][index]);