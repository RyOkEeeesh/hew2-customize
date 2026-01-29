import { create } from 'zustand';

export interface Command {
  undo: () => void;
  redo: () => void;
  dispose?: () => void;
}

type StoreState = {
  undoStack: Command[];
  redoStack: Command[];
  pushCommand: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
}

export const useStore = create<StoreState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  pushCommand: (cmd) => {
    const { redoStack } = get();
    redoStack.forEach(c => c.dispose?.());
    set((state) => ({
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    }));
  },
  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return;
    const cmd = undoStack[undoStack.length - 1];
    cmd.undo();
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cmd],
    });
  },
  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return;
    const cmd = redoStack[redoStack.length - 1];
    cmd.redo();
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, cmd],
    });
  },
}));

type ToolType = 'pen' | 'bucket';

type ToolsState = {
  tool: ToolType | null;
  penWidth: number;
  color: number;
  colors: number[];

  setTool: (tool: ToolType | null) => void;
  setPenWidth: (penWidth: number) => void;
  setColor: (color: number) => void;
  setColors: (colors: number[]) => void
  pushColors: (c: number) => void;
};

export const maxClrLen = 6;

const useTools = create<ToolsState>((set, get) => ({
  tool: null,
  penWidth: 1,
  color: 0x000,
  colors: [],

  setTool: tool => set({tool}),
  setPenWidth: penWidth => set({penWidth}),
  setColor: color => set({color}),
  setColors: colors => set({colors}),
  pushColors: color => {
    const clr = get().colors.slice();
    clr.unshift(color);
    set({colors: clr.slice(0, maxClrLen)});
  }

}));