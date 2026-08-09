import { defineMacro } from "@toolc/core";
import { z } from "zod";

/**
 * Provenance: the NWS API's canonical two-step — /points/{lat},{lon} to
 * resolve the forecast grid, then /gridpoints/{wfo}/{x},{y}/forecast — is the
 * classic chain agents fumble against the auto-generated surface (they call
 * gridpoint_forecast directly with lat/lon and fail). Verified live
 * 2026-08-09.
 */
export const getForecastForLocation = defineMacro({
  name: "get_forecast_for_location",
  description:
    "Given latitude and longitude in the United States, return the National Weather Service text forecast in one call. " +
    "Replaces the point → gridpoint_forecast chain (the grid resolution step is handled for you).",
  inputSchema: z.object({
    latitude: z.number().describe("e.g. 39.7456"),
    longitude: z.number().describe("e.g. -97.0892"),
  }),
  uses: ["nws:point", "nws:gridpoint_forecast"],
  steps: async (input, call) => {
    const point = await call("nws:point", {
      latitude: input.latitude,
      longitude: input.longitude,
    });
    if (point.isError) return point;

    let grid: { wfo?: string; x?: number; y?: number } = {};
    try {
      const parsed = JSON.parse(point.text) as {
        properties?: { gridId?: string; gridX?: number; gridY?: number };
      };
      grid = {
        wfo: parsed.properties?.gridId,
        x: parsed.properties?.gridX,
        y: parsed.properties?.gridY,
      };
    } catch {
      return { text: `could not parse grid from NWS point response`, isError: true };
    }
    if (!grid.wfo || grid.x === undefined || grid.y === undefined) {
      return {
        text: `no NWS forecast grid for ${input.latitude},${input.longitude} (US locations only)`,
        isError: true,
      };
    }
    return call("nws:gridpoint_forecast", { wfo: grid.wfo, x: grid.x, y: grid.y });
  },
});
