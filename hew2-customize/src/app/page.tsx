import React, {
  useState,
  useEffect,
} from 'react';
import { CookiesProvider, useCookies } from 'react-cookie';
import { Canvas } from '@react-three/fiber';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './store';
import { Scene } from './manhole';

type HtmlUIProps = {
  setTrigger: React.Dispatch<React.SetStateAction<boolean>>;
}

function HtmlUI({ setTrigger }: HtmlUIProps) {
  const { undo, redo, canUndo, canRedo } = useStore(
    useShallow((state) => ({
      undo: state.undo,
      redo: state.redo,
      canUndo: state.undoStack.length > 0,
      canRedo: state.redoStack.length > 0,
    }))
  );

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
        className="bg-white px-4 py-2 rounded shadow disabled:opacity-50"
        onClick={undo}
        disabled={!canUndo}
      >
        Undo
      </button>
      <button
        className="bg-white px-4 py-2 rounded shadow disabled:opacity-50"
        onClick={redo}
        disabled={!canRedo}
      >
        Redo
      </button>
      <button onClick={() => setTrigger(true)}>export</button>
    </div>
  );
}


// Main App

function App() {
  const [trigger, setTrigger] = useState<boolean>(false);

  return (
    <CookiesProvider>
      <div className='w-screen h-screen relative'>
        <HtmlUI setTrigger={setTrigger} />
        <Canvas
          className='block'
          style={{ background: '#d4d4d4', width: '100%', height: 'calc(100vh - var(--header-h))' }}
        >
          <Scene trigger={trigger} />
        </Canvas>
      </div>
    </CookiesProvider>
  );
}

export default function Page() {
  return <App />;
}