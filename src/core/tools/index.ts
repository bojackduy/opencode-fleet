/**
 * tools/index.ts — the runtime-agnostic fleet tool definitions: the 20
 * pre-existing tools in the same order the v1 plugin has always registered
 * them, plus the 5 Phase A exclusive-ownership tools (fleet_assign,
 * fleet_unassign, fleet_transfer, fleet_my_workers, fleet_unassigned) plus
 * Phase B1 per-commander watch/ack (fleet_watch scoped, fleet_ack).
 */

import type { ToolDef } from "../toolDef.js";
import { fleetRegisterDef } from "./fleetRegister.js";
import { fleetListDef } from "./fleetList.js";
import { fleetBroadcastDef } from "./fleetBroadcast.js";
import { fleetStatusDef } from "./fleetStatus.js";
import { fleetAgentsDef, fleetModelsDef } from "./fleetAgents.js";
import { fleetDiscoverDef, fleetPsDef } from "./fleetDiscover.js";
import { fleetExecDef } from "./fleetExec.js";
import { fleetHandoffBackDef, fleetThreadDef } from "./fleetHandoff.js";
import {
  fleetAllowDef,
  fleetBlockDef,
  fleetGroupDef,
  fleetPolicyDef,
  fleetSummaryDef,
} from "./fleetAdmin.js";
import {
  fleetClaimCommanderDef,
  fleetReleaseCommanderDef,
  fleetTreeDef,
} from "./fleetRoles.js";
import { fleetWatchDef, fleetAckDef } from "./fleetWatch.js";
import {
  fleetAssignDef,
  fleetMyWorkersDef,
  fleetTransferDef,
  fleetUnassignedDef,
  fleetUnassignDef,
} from "./fleetAssign.js";
import { fleetRecoverCommanderDef } from "./fleetRecover.js";

export const ALL_TOOL_DEFS: readonly ToolDef[] = [
  fleetRegisterDef,
  fleetListDef,
  fleetBroadcastDef,
  fleetStatusDef,
  fleetAgentsDef,
  fleetModelsDef,
  fleetDiscoverDef,
  fleetPsDef,
  fleetExecDef,
  fleetHandoffBackDef,
  fleetThreadDef,
  fleetAllowDef,
  fleetBlockDef,
  fleetPolicyDef,
  fleetSummaryDef,
  fleetGroupDef,
  fleetClaimCommanderDef,
  fleetReleaseCommanderDef,
  fleetTreeDef,
  fleetWatchDef,
  fleetAckDef,
  fleetAssignDef,
  fleetUnassignDef,
  fleetTransferDef,
  fleetMyWorkersDef,
  fleetUnassignedDef,
  fleetRecoverCommanderDef,
];
