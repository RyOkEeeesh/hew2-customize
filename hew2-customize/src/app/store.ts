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

export type ToolType = 'rotate' | 'pen' | 'bucket';

type ToolsState = {
  tool: ToolType;
  penWidth: number;
  baseColor: string;
  color: string;
  colors: string[];

  setTool: (tool: ToolType) => void;
  setPenWidth: (penWidth: number) => void;
  setBaseColor: (baseColor: string) => void;
  setColor: (color: string) => void;
  setColors: (colors: string[]) => void
  pushColors: (c: string) => void;
};

export const maxClrLen = 6;

export const useTools = create<ToolsState>((set, get) => ({
  tool: 'rotate',
  penWidth: 1,
  baseColor: null!,
  color: '0x666666',
  colors: [],

  setTool: tool => set({tool}),
  setPenWidth: penWidth => set({penWidth}),
  setBaseColor: baseColor => set({baseColor}),
  setColor: color => set({color}),
  setColors: colors => set({colors}),
  pushColors: color => {
    const colors = [color, ...get().colors.filter(c => c !== color)].slice(0, maxClrLen);
    set({colors});
  }
}));