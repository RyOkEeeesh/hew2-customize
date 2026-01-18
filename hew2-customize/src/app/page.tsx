import React, {
  forwardRef,
  useRef,
  useState,
  useEffect,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import {
  OrbitControls,
  PerspectiveCamera,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";
import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'

// ------------------------------
// Constants & Types
// ------------------------------
const EXTERNAL_SHAPE = 6.5;
const THICKNESS = 0.5;
const DENT = 0.07;
const DIFFERENCE = 0.4;

type Material = "metal" | "plastic";

const materialOfColor: Record<Material, THREE.MeshStandardMaterialParameters> = {
  metal: { color: "#666666", metalness: 0.6, roughness: 0.4 },
  plastic: { color: "#eeeeee", metalness: 0.1, roughness: 0.8 },
};

// ------------------------------
// Zustand Store (Undo/Redo Logic)
// ------------------------------

// コマンドの型定義（単なるオブジェクト）
interface Command {
  undo: () => void;
  redo: () => void;
}

interface DrawingState {
  undoStack: Command[];
  redoStack: Command[];
  pushCommand: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
}

const useStore = create<DrawingState>((set, get) => ({
  undoStack: [],
  redoStack: [],

  // 新しい操作が行われたとき
  pushCommand: (cmd) => {
    // 実行自体はComponent側で行い、ここではスタック管理のみ行う
    set((state) => ({
      undoStack: [...state.undoStack, cmd],
      redoStack: [], // 新しい分岐に入ったのでRedoはクリア
    }));
  },

  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return;

    const cmd = undoStack[undoStack.length - 1];
    cmd.undo(); // 実際の取り消し処理を実行

    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cmd],
    });
  },

  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return;

    const cmd = redoStack[redoStack.length - 1];
    cmd.redo(); // 実際の再実行処理を実行

    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, cmd],
    });
  },
}));

// ------------------------------
// Geometry Helpers (Pure Functions)
// ------------------------------
function getVec3Like(v: THREE.Vector2Like | THREE.Vector3Like) {
  return { x: v.x, y: v.y, z: ("z" in v ? (v.z ?? 0) : 0) };
}

function toFloat32Arr(v: THREE.Vector3Like[]) {
  const positions = new Float32Array(v.length * 3);
  v.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });
  return positions;
}

const tmpDir = new THREE.Vector2();
const tmpNormal = new THREE.Vector2();

function generateStrokePoints(points: THREE.Vector2Like[], radius: number) {
  const vertices: THREE.Vector2Like[] = [];
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    if (i < points.length - 1)
      tmpDir.set(points[i + 1].x - curr.x, points[i + 1].y - curr.y).normalize();
    else if (i > 0)
      tmpDir.set(curr.x - points[i - 1].x, curr.y - points[i - 1].y).normalize();

    tmpNormal.set(-tmpDir.y, tmpDir.x).multiplyScalar(radius);
    vertices.push({ x: curr.x + tmpNormal.x, y: curr.y + tmpNormal.y });
    vertices.push({ x: curr.x - tmpNormal.x, y: curr.y - tmpNormal.y });
  }
  return vertices;
}

function updateGeometry(geo: THREE.BufferGeometry, points: THREE.Vector2Like[]) {
  if (points.length < 2) return;
  const strokePoints = generateStrokePoints(points, 0.15).map(getVec3Like);
  // Z-fighting防止のオフセット
  const positions = toFloat32Arr([
    ...strokePoints.map((p) => ({ ...p, z: 0.01 })),
  ]);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.attributes.position.needsUpdate = true;
}

// ------------------------------
// Components
// ------------------------------

const ManholeMesh = forwardRef<THREE.Mesh, { mat: Material; [key: string]: any }>(
  ({ mat, ...props }, ref) => {
    const lathePoints = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(EXTERNAL_SHAPE, 0),
      new THREE.Vector2(EXTERNAL_SHAPE, THICKNESS),
      new THREE.Vector2(EXTERNAL_SHAPE - DIFFERENCE, THICKNESS),
      new THREE.Vector2(EXTERNAL_SHAPE - DIFFERENCE, THICKNESS - DENT),
    ];

    return (
      <group>
        <mesh position={[0, -THICKNESS / 2, 0]}>
          <latheGeometry args={[lathePoints, 128]} />
          <meshStandardMaterial {...materialOfColor[mat]} side={THREE.DoubleSide} />
        </mesh>
        <mesh
          ref={ref}
          position={[0, THICKNESS / 2 - DENT, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          {...props}
        >
          <circleGeometry args={[EXTERNAL_SHAPE - DIFFERENCE, 128]} />
          <meshStandardMaterial color="#333" transparent opacity={0.1} />
        </mesh>
      </group>
    );
  }
);

function Scene() {
  const groupRef = useRef<THREE.Group>(null!);
  const editMeshRef = useRef<THREE.Mesh>(null!);
  const drawingMeshRef = useRef<THREE.Mesh>(null!);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const pointsRef = useRef<THREE.Vector2Like[]>([]);
  const isPointsUpdateRef = useRef(false);

  // Zustandからアクションを取得
  const pushCommand = useStore((state) => state.pushCommand);

  // --- Rendering Loop (Preview Update) ---
  useFrame(() => {
    if (isDrawing && isPointsUpdateRef.current && drawingMeshRef.current) {
      updateGeometry(drawingMeshRef.current.geometry, pointsRef.current);
      isPointsUpdateRef.current = false;
    }
  });

  // --- Event Handlers ---
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.button !== 0) return;

    setIsDrawing(true);
    const localPoint = editMeshRef.current.worldToLocal(e.point.clone());
    pointsRef.current = [{ x: localPoint.x, y: localPoint.y }];
    isPointsUpdateRef.current = true;
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!isDrawing) return;
    e.stopPropagation();

    const localPoint = editMeshRef.current.worldToLocal(e.point.clone());
    const lastPoint = pointsRef.current[pointsRef.current.length - 1];
    
    // 間引き処理
    const dist = Math.hypot(localPoint.x - lastPoint.x, localPoint.y - lastPoint.y);
    if (dist < 0.1) return;

    pointsRef.current.push({ x: localPoint.x, y: localPoint.y });
    isPointsUpdateRef.current = true;
  };

  const onPointerUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (pointsRef.current.length < 2) return;

    // 1. メッシュの生成
    const geo = new THREE.BufferGeometry();
    updateGeometry(geo, pointsRef.current);
    const mat = new THREE.MeshStandardMaterial({ color: "orange", side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);

    // 2. 位置合わせ
    mesh.position.copy(editMeshRef.current.position);
    mesh.rotation.copy(editMeshRef.current.rotation);
    
    // 3. 親に追加（Sceneへの反映）
    groupRef.current.add(mesh);

    // 4. コマンドオブジェクトを作成してZustandにPush
    // クラスではなく、クロージャを使ったオブジェクトを作成
    const parent = groupRef.current;
    
    const command: Command = {
      undo: () => {
        parent.remove(mesh);
      },
      redo: () => {
        parent.add(mesh);
      }
    };

    pushCommand(command);

    // リセット
    pointsRef.current = [];
  };

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 15, 15]} fov={45} />
      {/* 描画中は回転させない */}
      <OrbitControls makeDefault enableRotate={!isDrawing} />

      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} />

      <group ref={groupRef}>
        <ManholeMesh
          ref={editMeshRef}
          mat="metal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        {/* 描画中のプレビュー用メッシュ */}
        <mesh 
          ref={drawingMeshRef} 
          visible={isDrawing}
          position={[0, THICKNESS / 2 - DENT, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <bufferGeometry />
          <meshStandardMaterial color="orange" side={THREE.DoubleSide} />
        </mesh>
      </group>

      <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
        <GizmoViewport />
      </GizmoHelper>
    </>
  );
}

// ------------------------------
// UI Component (Outside Canvas)
// ------------------------------
function HtmlUI() {
  // useShallow で囲むことで、中身が同じなら「変更なし」とみなしてくれる
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
      // ⌘+Z または Ctrl+Z
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) redo();
        else undo();
      }
      // ⌘+Y または Ctrl+Y (Redo)
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return (
    <div style={{ position: "absolute", top: 20, left: 20, zIndex: 10, display: "flex", gap: "10px" }}>
      <button 
        style={{ padding: "8px 16px", cursor: canUndo ? "pointer" : "not-allowed", opacity: canUndo ? 1 : 0.5 }} 
        onClick={undo}
        disabled={!canUndo}
      >
        Undo
      </button>
      <button 
        style={{ padding: "8px 16px", cursor: canRedo ? "pointer" : "not-allowed", opacity: canRedo ? 1 : 0.5 }} 
        onClick={redo}
        disabled={!canRedo}
      >
        Redo
      </button>
    </div>
  );
}

// ------------------------------
// Main App
// ------------------------------
export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh", background: "#222", position: "relative" }}>
      <HtmlUI />
      <Canvas shadows>
        <Scene />
      </Canvas>
    </div>
  );
}