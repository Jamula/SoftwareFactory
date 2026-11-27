import { CanvasError, createCanvas, joinSession } from "@microsoft/copilot-sdk/extension";
import { startFactoryBoardExtension } from "./board-ui.mjs";

await startFactoryBoardExtension({ CanvasError, createCanvas, joinSession });
