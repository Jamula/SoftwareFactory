import { createCanvas, CanvasError, joinSession } from "@microsoft/copilot-sdk/extension";
import { createBoardInstanceManager, createFactoryBoardCanvasSpec } from "./board-ui.mjs";

let activeSession = null;

const manager = createBoardInstanceManager({
  onLog: (message, options) => {
    if (activeSession && typeof activeSession.log === "function") {
      activeSession.log(message, options);
    }
  },
});

const factoryBoardCanvas = createCanvas(
  createFactoryBoardCanvasSpec({ CanvasError, manager }),
);

activeSession = await joinSession({
  canvases: {
    definitions: [factoryBoardCanvas],
  },
  hooks: {
    handlers: {
      onSessionEnd: async () => {
        await manager.closeAll();
      },
    },
  },
});
