import React, {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
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
// import type { CSGMsg, CSGResult, CSGType, IslMsg, IslResult } from './types'; // 環境に合わせてパスを確認してください
import { getVec3Like, meshMatrixUpdate } from './threeUnits';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CSGMsg, CSGResult, CSGType, IslMsg, IslResult } from './types';
import { fitObject, fitObjectFast } from './camCtrl';


// ------------------------------
// Constants & Types
// ------------------------------
const EXTERNAL_SHAPE = 6.5;
const THICKNESS = 0.5;
const DENT = 0.2;
const DIFFERENCE = 0.4;

type Material = 'metal' | 'plastic';

const materialOfColor: Record<Material, THREE.MeshStandardMaterialParameters> = {
  metal: { color: '#666666', metalness: 0.6, roughness: 0.4 },
  plastic: { color: '#eeeeee', metalness: 0.1, roughness: 0.8 },
};

const box1 = new THREE.Box3()
const box2 = new THREE.Box3()
function checkCollision(mesh1: THREE.Mesh, mesh2: THREE.Mesh): boolean {
  if (!mesh1 || !mesh2) return false
  // updateMatrixWorldはコストがかかるため、必要なタイミングでのみ呼ぶのが良いですが、
  // ここでは念のため呼んでおきます。
  mesh1.updateMatrixWorld();
  mesh2.updateMatrixWorld();
  box1.setFromObject(mesh1)
  box2.setFromObject(mesh2)
  return box1.intersectsBox(box2)
}


// ------------------------------
// Zustand Store (Undo/Redo Logic)
// ------------------------------
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
  pushCommand: (cmd) => {
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

// ------------------------------
// WebWorker Hook
// ------------------------------
export function useWebWorker() {
  const csgWorkerRef = useRef<Worker | null>(null);
  const islWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Workerのパスは環境に合わせて調整してください
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

      // indexがない場合のフォールバック
      const indexA = geoA.index ? geoA.index.array.slice() : undefined;
      const indexB = geoB.index ? geoB.index.array.slice() : undefined;

      const msg: CSGMsg = {
        type,
        obj: {
          positionA: geoA.attributes.position.array.slice(),
          normalA: geoA.attributes.normal.array.slice(),
          indexA: indexA,
          positionB: geoB.attributes.position.array.slice(),
          normalB: geoB.attributes.normal.array.slice(),
          indexB: indexB,
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

      const geo = mesh.geometry.clone();

      const msg: IslMsg = {
        positions: geo.attributes.position.array.slice(),
        normals: geo.attributes.normal.array.slice(),
      };
      const transfer: ArrayBufferLike[] = [
        msg.positions.buffer,
        msg.normals.buffer,
      ];

      islWorker?.postMessage(msg, transfer);
    })
  }

  return { postCsgWorker, postIslWorker };
}

// ------------------------------
// Geometry Helpers
// ------------------------------
const tmpDir = new THREE.Vector2();
const tmpNormal = new THREE.Vector2();

function updateGeometry(geo: THREE.BufferGeometry, points: THREE.Vector2Like[]) {
  if (points.length < 2) {
    geo.deleteAttribute('position');
    geo.setIndex(null);
    return;
  }

  const radius = 0.1;
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

    // 0:上左, 1:上右, 2:底左, 3:底右
    // 上面を depth (Z=0.2), 底面を 0 (Z=0) と仮定
    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, depth);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, depth);
    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, 0);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, 0);

    const currIdx = 4 * i;

    // 蓋 (始点)
    if (i === 0) {
      indices.push(currIdx + 0, currIdx + 2, currIdx + 1);
      indices.push(currIdx + 1, currIdx + 2, currIdx + 3);
    }

    // 側面・上面・底面
    if (i > 0) {
      const prev = 4 * (i - 1);
      // 上面
      indices.push(prev + 0, prev + 1, currIdx + 0);
      indices.push(prev + 1, currIdx + 1, currIdx + 0);
      // 底面
      indices.push(prev + 2, currIdx + 2, prev + 3);
      indices.push(prev + 3, currIdx + 2, currIdx + 3);
      // 側面
      indices.push(prev + 0, currIdx + 0, prev + 2);
      indices.push(prev + 2, currIdx + 0, currIdx + 2);
      indices.push(prev + 1, prev + 3, currIdx + 1);
      indices.push(prev + 3, currIdx + 3, currIdx + 1);
    }

    // 蓋 (終点)
    if (i === points.length - 1 && i > 0) {
      indices.push(currIdx + 0, currIdx + 1, currIdx + 2);
      indices.push(currIdx + 1, currIdx + 3, currIdx + 2);
    }
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // UVは省略
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
      new THREE.Vector2(EXTERNAL_SHAPE - DIFFERENCE, THICKNESS - DENT - 0.1),
      new THREE.Vector2(0, THICKNESS - DENT - 0.1),
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
  const { camera } = useThree();

  const groupRef = useRef<THREE.Group>(null!);
  const convexGroupRef = useRef<THREE.Group>(null!);
  const concaveGroupRef = useRef<THREE.Group>(null!);

  const editMeshRef = useRef<THREE.Mesh>(null!);
  const drawingMeshRef = useRef<THREE.Mesh>(null!);

  const [isDrawing, setIsDrawing] = useState(false);
  const pointsRef = useRef<THREE.Vector2Like[]>([]);
  const isPointsUpdateRef = useRef(false);

  const { postCsgWorker, postIslWorker } = useWebWorker();
  const pushCommand = useStore((state) => state.pushCommand);

  useFrame(() => {
    if (isDrawing && isPointsUpdateRef.current && drawingMeshRef.current) {
      updateGeometry(drawingMeshRef.current.geometry, pointsRef.current);
      isPointsUpdateRef.current = false;
    }
  });


  useEffect(() => {
    if (!editMeshRef.current || !concaveGroupRef.current) return;
    const mesh = new THREE.Mesh(
      editMeshRef.current.geometry.clone(),
      new THREE.MeshStandardMaterial({ wireframe: true }) // 確認用にNormalMaterialを使用
    );
    // 初期位置合わせ
    mesh.position.copy(editMeshRef.current.position);
    mesh.position.y += 0.1; // 視認用オフセット
    mesh.rotation.copy(editMeshRef.current.rotation);
    mesh.updateMatrixWorld();

    concaveGroupRef.current.add(mesh);
  }, []);

  const cameraPosRef = useRef<THREE.Vector3>(new THREE.Vector3());

  useLayoutEffect(() => {
    if (!groupRef.current) return;
    const cam = camera as THREE.PerspectiveCamera;
    fitObject(cam, groupRef.current, 1.1);
    cam.updateProjectionMatrix();
    cameraPosRef.current.copy(cam.position);
  }, [camera, groupRef.current]);

  /**
     * 描画されたメッシュ(cutter)を使って、targetMeshをくり抜く
     */
  async function applySubtraction(targetMesh: THREE.Mesh, cutterMesh: THREE.Mesh): Promise<THREE.Mesh | null> {
    targetMesh.updateMatrixWorld(true);
    cutterMesh.updateMatrixWorld(true);

    // 1. ワールド座標系で計算するためにBake（ここまではOK）
    const targetGeo = BufferGeometryUtils.mergeVertices(targetMesh.geometry.clone());
    targetGeo.applyMatrix4(targetMesh.matrixWorld);

    const cutterGeo = BufferGeometryUtils.mergeVertices(cutterMesh.geometry.clone());
    cutterGeo.applyMatrix4(cutterMesh.matrixWorld);

    try {
      const res = await postCsgWorker(targetGeo, cutterGeo, 'sub');

      if (res.success && res.result) {
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.result.position), 3));
        newGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(res.result.normal), 3));
        if (res.result.index) {
          newGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(res.result.index), 1));
        }

        // ===============================================
        // ★ここが修正ポイント
        // ワールド座標になっているジオメトリを、親(concaveGroupRef)のローカル座標に戻す
        // ===============================================
        if (targetMesh.parent) {
          const inverseParentMat = targetMesh.parent.matrixWorld.clone().invert();
          newGeo.applyMatrix4(inverseParentMat);
        }

        // メッシュ自体のTransformはリセット（ジオメトリ自体が正しい位置にあるため）
        const newMesh = new THREE.Mesh(newGeo, targetMesh.material);
        newMesh.castShadow = true;
        newMesh.receiveShadow = true;

        return newMesh;
      }
    } catch (e) {
      console.error("CSG Error:", e);
    }
    return null;
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
    pointerEventTmpVec3.current.copy(e.point);
    editMeshRef.current.worldToLocal(pointerEventTmpVec3.current)

    const lastPoint = pointsRef.current[pointsRef.current.length - 1];
    if (lastPoint) {
      const dist = Math.sqrt(Math.pow(pointerEventTmpVec3.current.x - lastPoint.x, 2) + Math.pow(pointerEventTmpVec3.current.y - lastPoint.y, 2));
      if (dist < 0.05) return;
    }

    pointsRef.current.push({ x: pointerEventTmpVec3.current.x, y: pointerEventTmpVec3.current.y });
    isPointsUpdateRef.current = true;
  };

  const handleFinDrawing = async () => {
    if (!isDrawing) return;

    if (pointsRef.current.length < 2) {
      if (drawingMeshRef.current) drawingMeshRef.current.geometry.deleteAttribute('position');
      return;
    }

    // --- 1. Cutter (描いた形状) メッシュの作成 ---
    const geo = new THREE.BufferGeometry();
    updateGeometry(geo, pointsRef.current);

    const cutterMesh = new THREE.Mesh(geo);

    // 位置合わせ
    cutterMesh.position.copy(drawingMeshRef.current.position);
    cutterMesh.rotation.copy(drawingMeshRef.current.rotation);

    const concaveParent = concaveGroupRef.current;
    const children = concaveParent.children.filter(o => o instanceof THREE.Mesh) as THREE.Mesh[];

    const convexParent = convexGroupRef.current;

    // 衝突しているターゲットを探す
    const targetMesh = children.find(m => checkCollision(m, cutterMesh));

    if (targetMesh) {
      // 計算実行
      const resultMesh = await applySubtraction(targetMesh, cutterMesh);

      if (resultMesh) {
        const isl = await postIslWorker(resultMesh);
        console.log(isl);
        // --- 3. メッシュの入れ替えとUndo/Redo登録 ---

        // シーン更新
        concaveParent.remove(targetMesh);
        concaveParent.add(resultMesh);
        convexParent.add(cutterMesh)

        // コマンド作成
        const command: Command = {
          undo: () => {
            convexParent.remove(cutterMesh)
            concaveParent.remove(resultMesh);
            concaveParent.add(targetMesh);
          },
          redo: () => {
            convexParent.add(cutterMesh)
            concaveParent.remove(targetMesh);
            concaveParent.add(resultMesh);
          }
        };

        pushCommand(command);
      }
    }

    // リセット
    pointsRef.current = [];
    drawingMeshRef.current.geometry.deleteAttribute('position');
    drawingMeshRef.current.geometry.setIndex(null);
    // メモリリーク防止のためジオメトリ破棄
    geo.dispose();
    setIsDrawing(false);

  };

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 20, 0]} fov={45} />
      <OrbitControls makeDefault enableRotate={!isDrawing} />

      <ambientLight color={0xffffff} intensity={1} />
      <directionalLight position={[0, 5, 0]} intensity={0.4} />

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
        <group ref={concaveGroupRef}></group>

        {/* 描画中のプレビュー用メッシュ */}
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
// UI Component (Undo/Redo Button)
// ------------------------------
function HtmlUI() {
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
    </div>
  );
}

// ------------------------------
// Main App
// ------------------------------
export default function App() {
  return (
    <CookiesProvider>
      <div className='w-screen h-screen relative'>
        <HtmlUI />
        <Canvas
          className='block'
          style={{ background: '#d4d4d4', width: '100%', height: 'calc(100vh - var(--header-h))' }}
        >
          <Scene />
        </Canvas>
      </div>
    </CookiesProvider>
  );
}