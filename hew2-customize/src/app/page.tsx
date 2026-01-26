import React, {
  forwardRef,
  useRef,
  useState,
  useEffect,
} from 'react';
import { CookiesProvider, useCookies } from 'react-cookie';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  OrbitControls,
  PerspectiveCamera,
  GizmoHelper,
  GizmoViewport,
} from '@react-three/drei';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { CSGMsg, CSGResult, CSGType, IslMsg, IslResult } from './types';
import { getVec3Like, meshMatrixUpdate } from './threeUnits';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as CSG from 'three-bvh-csg';

// ------------------------------
// Constants & Types
// ------------------------------
const EXTERNAL_SHAPE = 6.5;
const THICKNESS = 0.5;
const DENT = 0.15;
const DIFFERENCE = 0.4;

type Material = 'metal' | 'plastic';

const materialOfColor: Record<Material, THREE.MeshStandardMaterialParameters> = {
  metal: { color: '#666666', metalness: 0.6, roughness: 0.4 },
  plastic: { color: '#eeeeee', metalness: 0.1, roughness: 0.8 },
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

// csg

const subMesh = new THREE.Mesh(
  new THREE.CircleGeometry(EXTERNAL_SHAPE - DIFFERENCE, 128),
)

// webWorker

export function useWebWorker() {
  const csgWorkerRef = useRef<Worker | null>(null);
  const islWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const csg = new Worker(new URL('./CSGWorker.ts', import.meta.url), { type: 'module' });
    const isl = new Worker(new URL('./islWorker.ts', import.meta.url), { type: 'module' });
    csgWorkerRef.current = csg;
    islWorkerRef.current = isl;
    return () => {
      csg.terminate();
      isl.terminate();
    };
  }, []);


  function postCsgWorker(geoA: THREE.BufferGeometry, geoB: THREE.BufferGeometry, type: CSGType): Promise<CSGResult> {
    return new Promise((resolve, reject) => {
      const CSGWorker = csgWorkerRef.current;
      if (!CSGWorker) return reject(new Error('CSGWorker not initialized'));

      const handleMessage = (e: MessageEvent<CSGResult>) => {
        CSGWorker.removeEventListener('message', handleMessage);
        CSGWorker.removeEventListener('error', handleError);
        if (e.data.success) resolve(e.data);
        else reject(new Error(e.data.error || 'CSG calculation failed'));
      };

      const handleError = (err: ErrorEvent) => {
        CSGWorker.removeEventListener('message', handleMessage);
        CSGWorker.removeEventListener('error', handleError);
        reject(err);
      };

      CSGWorker.addEventListener('message', handleMessage);
      CSGWorker.addEventListener('error', handleError);

      const msg: CSGMsg = {
        type,
        obj: {
          positionA: geoA.attributes.position.array.slice(),
          normalA: geoA.attributes.normal.array.slice(),
          indexA: geoA.index?.array.slice(),
          positionB: geoB.attributes.position.array.slice(),
          normalB: geoB.attributes.normal.array.slice(),
          indexB: geoB.index?.array.slice(),
        }
      };

      const transfer: ArrayBufferLike[] = [
        msg.obj.positionA.buffer,
        msg.obj.normalA.buffer,
        msg.obj.positionB.buffer,
        msg.obj.normalB.buffer,
      ];
      if (msg.obj.indexA) transfer.push(msg.obj.indexA.buffer);
      if (msg.obj.indexB) transfer.push(msg.obj.indexB.buffer);

      CSGWorker.postMessage(msg, transfer);
    });
  };

  function postIslWorker(mesh: THREE.Mesh): Promise<IslResult> {
    return new Promise((resolve, reject) => {
      const islWorker = islWorkerRef.current;
      if (!islWorker) return reject(new Error('IslWorker not initialized'));

      const handleMessage = (e: MessageEvent<IslResult>) => {
        islWorker.removeEventListener('message', handleMessage);
        islWorker.removeEventListener('error', handleError);
        if (e.data.success) resolve(e.data);
        else reject(new Error(e.data.error || 'IslWorker calculation failed'));
      };

      const handleError = (err: ErrorEvent) => {
        islWorker.removeEventListener('message', handleMessage);
        islWorker.removeEventListener('error', handleError);
        reject(err);
      };

      islWorker.addEventListener('message', handleMessage);
      islWorker.addEventListener('error', handleError);

      const msg: IslMsg = {
        positions: mesh.geometry.attributes.position.array,
        normals: mesh.geometry.attributes.normal.array,
      };
      const transfer: ArrayBufferLike[] = [
        msg.positions.buffer,
        msg.normals.buffer,
      ];

      islWorker?.postMessage(msg, transfer);
    })
  }

  return { postCsgWorker, postIslWorker, CSGWorker: csgWorkerRef.current, islWorker: islWorkerRef.current };
}

// ------------------------------
// Geometry Helpers (Pure Functions)
// ------------------------------

const tmpDir = new THREE.Vector2();
const tmpNormal = new THREE.Vector2();

function updateGeometry(geo: THREE.BufferGeometry, points: THREE.Vector2Like[]) {
  if (points.length < 2) {
    geo.deleteAttribute('position');
    geo.setIndex(null);
    return;
  }

  const radius = 0.15;
  const depth = DENT;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];

    if (i < points.length - 1)
      tmpDir.set(points[i + 1].x - curr.x, points[i + 1].y - curr.y).normalize();
    else if (i > 0)
      tmpDir.set(curr.x - points[i - 1].x, curr.y - points[i - 1].y).normalize();

    tmpNormal.set(-tmpDir.y, tmpDir.x).multiplyScalar(radius);

    // 頂点定義 (0:上左, 1:上右, 2:底左, 3:底右)
    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, depth);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, depth);
    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, 0);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, 0);

    const currIdx = 4 * i;

    // --- 始点の蓋 (i = 0) ---
    if (i === 0) {
      indices.push(currIdx + 0, currIdx + 2, currIdx + 1);
      indices.push(currIdx + 1, currIdx + 2, currIdx + 3);
    }

    // --- 胴体部分の面 ---
    if (i > 0) {
      const prev = 4 * (i - 1);
      // 上面
      indices.push(prev + 0, prev + 1, currIdx + 0);
      indices.push(prev + 1, currIdx + 1, currIdx + 0);
      // 底面
      indices.push(prev + 2, currIdx + 2, prev + 3);
      indices.push(prev + 3, currIdx + 2, currIdx + 3);
      // 側面（左）
      indices.push(prev + 0, currIdx + 0, prev + 2);
      indices.push(prev + 2, currIdx + 0, currIdx + 2);
      // 側面（右）
      indices.push(prev + 1, prev + 3, currIdx + 1);
      indices.push(prev + 3, currIdx + 3, currIdx + 1);
    }

    // --- 終点の蓋 (i = 最後) ---
    if (i === points.length - 1 && i > 0) {
      indices.push(currIdx + 0, currIdx + 1, currIdx + 2);
      indices.push(currIdx + 1, currIdx + 3, currIdx + 2);
    }
  }

  const uvCount = vertices.length / 3;
  const uvs = new Float32Array(uvCount * 2);
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.attributes.position.needsUpdate = true;
}

// ------------------------------
// Components
// ------------------------------
const ManholeMesh = forwardRef<THREE.Mesh, { mat: Material;[key: string]: any }>(
  ({ mat, ...props }, ref) => {
    const lathePoints = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(EXTERNAL_SHAPE, 0),
      new THREE.Vector2(EXTERNAL_SHAPE, THICKNESS),
      new THREE.Vector2(EXTERNAL_SHAPE - DIFFERENCE, THICKNESS),
      new THREE.Vector2(EXTERNAL_SHAPE - DIFFERENCE, THICKNESS - DENT),
      new THREE.Vector2(0, THICKNESS - DENT),
    ];

    return (
      <>
        <mesh position={[0, -THICKNESS / 2, 0]}>
          <latheGeometry args={[lathePoints, 128]} />
          <meshStandardMaterial {...materialOfColor[mat as Material]} side={THREE.DoubleSide} />
        </mesh>
        <mesh
          ref={ref}
          position={[0, THICKNESS / 2 - DENT, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          {...props}
        >
          <circleGeometry args={[EXTERNAL_SHAPE - DIFFERENCE, 128]} />
          <meshStandardMaterial transparent opacity={0} />
        </mesh>
      </>
    );
  }
);



function Scene() {
  const { scene } = useThree();
  scene.add(subMesh);
  const groupRef = useRef<THREE.Group>(null!);
  const convexGroupRef = useRef<THREE.Group>(null!);
  const concavGroupRef = useRef<THREE.Group>(null!);
  const editMeshRef = useRef<THREE.Mesh>(null!);
  const drawingMeshRef = useRef<THREE.Mesh>(null!);

  const [isDrawing, setIsDrawing] = useState(false);
  const pointsRef = useRef<THREE.Vector2Like[]>([]);
  const isPointsUpdateRef = useRef(false);

  const { postCsgWorker } = useWebWorker();

  // Zustandからアクションを取得
  const pushCommand = useStore((state) => state.pushCommand);

  useFrame(() => {
    if (isDrawing && isPointsUpdateRef.current && drawingMeshRef.current) {
      updateGeometry(drawingMeshRef.current.geometry, pointsRef.current);
      isPointsUpdateRef.current = false;
    }
  });

  useEffect(() => {
    if (!editMeshRef.current || !concavGroupRef.current) return;
    const mesh = new THREE.Mesh(
      editMeshRef.current.geometry.clone(),
      new THREE.MeshNormalMaterial()
    );
    mesh.position.copy(editMeshRef.current.position);
    mesh.rotation.copy(editMeshRef.current.rotation);
    concavGroupRef.current.add(mesh);
  }, [])

  function normalizePositions(geo: THREE.BufferGeometry) {
    const cleanedGeo = BufferGeometryUtils.mergeVertices(geo, 0.001);
    cleanedGeo.computeVertexNormals();
    return cleanedGeo;
  }

  async function landMesh(mesh: THREE.Mesh) {
    mesh.updateMatrixWorld(true);

    const drawGeo = mesh.geometry.clone();
    drawGeo.applyMatrix4(mesh.matrixWorld);

    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);

    const subGeo = subMesh.geometry.clone();

    const res = await postCsgWorker(
      BufferGeometryUtils.mergeVertices(subGeo),
      BufferGeometryUtils.mergeVertices(drawGeo),
      'sub'
    );

    const geo = new THREE.BufferGeometry();

    if (res.success && res.result) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.result.position), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(res.result.normal), 3));
      if (res.result.index)
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(res.result.index), 1));
    } else {
      return drawGeo;
    }

    return normalizePositions(geo);
  }


  // --- Event Handlers ---
  const pointerEventTmpVec3 = useRef<THREE.Vector3>(new THREE.Vector3());
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setIsDrawing(true);
    pointerEventTmpVec3.current.copy(e.point);
    editMeshRef.current.worldToLocal(pointerEventTmpVec3.current);
    pointsRef.current = [{ x: pointerEventTmpVec3.current.x, y: pointerEventTmpVec3.current.y }];
    isPointsUpdateRef.current = true;
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!isDrawing) return;
    e.stopPropagation();
    e.stopPropagation();
    pointerEventTmpVec3.current.copy(e.point);
    editMeshRef.current.worldToLocal(pointerEventTmpVec3.current)
    if (pointsRef.current.length && pointerEventTmpVec3.current.distanceTo(getVec3Like(pointsRef.current[pointsRef.current.length - 1])) < 0.1) return;
    pointsRef.current.push({ x: pointerEventTmpVec3.current.x, y: pointerEventTmpVec3.current.y });
    isPointsUpdateRef.current = true;
  };

  const handleFinDrawing = async () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (pointsRef.current.length < 2) {
      drawingMeshRef.current.geometry.deleteAttribute('position');
      return;
    }

    const geo = new THREE.BufferGeometry;
    updateGeometry(geo, pointsRef.current);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 'orange',
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(1, 1, 1.2);
    mesh.position.y -= 0.2
    meshMatrixUpdate(mesh);

    const g = await landMesh(mesh);
    setGeoTmp(g);

    // 2. 位置合わせ
    mesh.position.copy(editMeshRef.current.position);
    mesh.rotation.copy(editMeshRef.current.rotation);

    meshMatrixUpdate(mesh);

    // 3. 親に追加（Sceneへの反映）
    concavGroupRef.current.add(mesh);

    // 4. コマンドオブジェクトを作成してZustandにPush
    // クラスではなく、クロージャを使ったオブジェクトを作成
    const parent = concavGroupRef.current;

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
    drawingMeshRef.current.geometry.deleteAttribute('position');
    drawingMeshRef.current.geometry.setIndex(null);
  };

  const [geoTmp, setGeoTmp] = useState<THREE.BufferGeometry>(null!);


  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 20, 0]} fov={45} />
      {/* 描画中は回転させない */}
      <OrbitControls makeDefault enableRotate={!isDrawing} />

      <ambientLight color={0xffffff} intensity={1} />
      <directionalLight position={[0, 5, 0]} intensity={0.4} />

      {geoTmp && (
        <mesh geometry={geoTmp}>
          <meshStandardMaterial wireframe />
        </mesh>
      )}

      <group ref={groupRef}>
        <ManholeMesh
          ref={editMeshRef}
          mat='metal'
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={handleFinDrawing}
          onPointerLeave={handleFinDrawing}
        />

        <group ref={convexGroupRef}></group>
        <group ref={concavGroupRef}></group>

        <mesh
          ref={drawingMeshRef}
          visible={isDrawing}
          position={[0, THICKNESS / 2 - DENT, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <bufferGeometry />
          <meshStandardMaterial color='orange' side={THREE.DoubleSide} />
        </mesh>
      </group>

      <GizmoHelper alignment='bottom-right' margin={[80, 80]}>
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
    <div className='flex gap-10'>
      <button
        style={{ padding: '8px 16px', cursor: canUndo ? 'pointer' : 'not-allowed', opacity: canUndo ? 1 : 0.5 }}
        onClick={undo}
        disabled={!canUndo}
      >
        Undo
      </button>
      <button
        style={{ padding: '8px 16px', cursor: canRedo ? 'pointer' : 'not-allowed', opacity: canRedo ? 1 : 0.5 }}
        onClick={redo}
        disabled={!canRedo}
      >
        Redo
      </button>
    </div>
  );
}

type EditType = 'pen' | 'line' | 'bucket' | 'shapes' | 'move';

type ToolBarBtnProps = {
  onClick: () => void;
  children: React.ReactNode;
}

function ToolBarBtn({ onClick, children }: ToolBarBtnProps) {
  return <button className='h-10 w-10 flex items-center justify-center' onClick={onClick}>{children}</button>
}

function ToolBar() {
  function handleBtnClick(type: EditType) {
    // if (editor !== type) setEditor(type);
  }
  return (
    <nav className='flex gap-4'>
      {/* {Object.entries(editorOptions).map(([k, v]) => (<ToolBarBtn key={k} onClick={() => handleBtnClick(k as EditType)}>{v.jsx}</ToolBarBtn>))} */}
    </nav>
  )
}

function ToolOption() {
  const [cookies, setCookie, removeCookie] = useCookies(['customize-options']);
  console.log(cookies)
  return null;
}

// ------------------------------
// Main App
// ------------------------------
export default function App() {
  return (
    <CookiesProvider>
      <header className='h-header-h w-screen bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'>
        <ToolBar />
        <ToolOption />
        <HtmlUI />
      </header>
      <Canvas
        className='block'
        style={{ background: '#d4d4d4', height: 'calc(100vh - var(--header-h))' }}
      >
        <Scene />
      </Canvas>
    </CookiesProvider>
  );
}