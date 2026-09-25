/**
 * tools/index.ts — the 19 runtime-agnostic fleet tool definitions, in the
 * same order the v1 plugin has always registered them.
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
];
