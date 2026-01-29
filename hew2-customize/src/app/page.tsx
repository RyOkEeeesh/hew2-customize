import React, {
  useState,
  useEffect,
} from 'react';
import { CookiesProvider, useCookies } from 'react-cookie';
import { Canvas } from '@react-three/fiber';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useTools } from './store';
import { Scene } from './manhole';
import { Hand, PaintBucket, Pen, Redo2, RotateCw, Save, Undo2 } from 'lucide-react';
import { ChromePicker, CirclePicker, type ColorResult } from 'react-color';

type HtmlUIProps = {
  setTrigger: React.Dispatch<React.SetStateAction<boolean>>;
}

function ToolOptions() {
  const { baseColor, color, colors, setColor, pushColors } = useTools(useShallow(s => ({ ...s })));
  return (
    <>
      {baseColor &&
        <CirclePicker
          colors={[...colors, baseColor]}
          onChangeComplete={c => setColor(c.hex)}
        />}
      <ChromePicker
        color={color}
        disableAlpha={true}
        onChangeComplete={c => {
          setColor(c.hex);
          pushColors(c.hex);
        }}
      />
    </>

  )
}

function HtmlUI({ setTrigger }: HtmlUIProps) {
  const { undo, redo, canUndo, canRedo } = useStore(
    useShallow(s => ({
      undo: s.undo,
      redo: s.redo,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
    }))
  );

  const { tool, setTool } = useTools(useShallow(s => ({ ...s })));


  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return (
    <div className='flex gap-4 absolute top-4 right-4 z-10'>
      <button
        onClick={() => setTool('rotate')}
        disabled={tool === 'rotate'}
        title='プレビュー'
      >
        <Hand size={20} strokeWidth={2.5} />
      </button>
      <button
        onClick={() => setTool('pen')}
        disabled={tool === 'pen'}
        title='ペン'
      >
        <Pen size={20} strokeWidth={2.5} />
      </button>
      <button
        onClick={() => setTool('bucket')}
        disabled={tool === 'bucket'}
        title='色'
      >
        <PaintBucket size={20} strokeWidth={2.5} />
      </button>
      <button
        onClick={undo}
        disabled={!canUndo}
        title='元に戻す'
      >
        <Undo2 size={20} strokeWidth={2.5} />
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title='やり直す'
      >
        <Redo2 size={20} strokeWidth={2.5} />
      </button>
      <button
        onClick={() => setTrigger(true)}
        title='保存'
      >
        <Save size={20} strokeWidth={2.5} />
      </button>
      <ToolOptions />
    </div>
  );
}


// Main App

function App() {
  const [trigger, setTrigger] = useState<boolean>(false);

  return (
    <div className='w-screen h-screen relative'>
      <HtmlUI setTrigger={setTrigger} />
      <Canvas
        className='block'
        style={{ background: '#d4d4d4', width: '100%', height: 'calc(100vh - var(--header-h))' }}
      >
        <Scene trigger={trigger} />
      </Canvas>
    </div>
  );
}

export default function Page() {
  return (
    <CookiesProvider>
      <App />
    </CookiesProvider>
  );
}