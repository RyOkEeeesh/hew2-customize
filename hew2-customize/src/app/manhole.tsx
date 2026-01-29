import React, {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
} from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  OrbitControls,
  PerspectiveCamera,
  GizmoHelper,
  GizmoViewport,
} from '@react-three/drei';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CSGMsg, CSGResult, CSGType, IslMsg, IslResult } from './types';
import { fitObject } from './camCtrl';
import { exportGroupToGLB } from './export';
import { useStore, type Command } from './store';
import { meshAttrDispose } from './threeUnits';

const EXTERNAL_SHAPE = 6.5;
const THICKNESS = 0.5;
const DENT = 0.2;
const DIFFERENCE = 0.4;

type Material = 'metal' | 'plastic';

const materialOfColor: Record<Material, THREE.MeshStandardMaterialParameters> = {
  metal: { color: '#666666', metalness: 0.6, roughness: 0.4 },
  plastic: { color: '#eeeeee', metalness: 0.1, roughness: 0.8 },
};

const box1 = new THREE.Box3();
const box2 = new THREE.Box3();
function checkCollision(mesh1: THREE.Mesh, mesh2: THREE.Mesh): boolean {
  if (!mesh1 || !mesh2) return false
  mesh1.updateMatrixWorld();
  mesh2.updateMatrixWorld();
  box1.setFromObject(mesh1)
  box2.setFromObject(mesh2)
  return box1.intersectsBox(box2)
}

function useWebWorker() {
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

    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, depth);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, depth);
    vertices.push(curr.x + tmpNormal.x, curr.y + tmpNormal.y, 0);
    vertices.push(curr.x - tmpNormal.x, curr.y - tmpNormal.y, 0);

    const currIdx = 4 * i;

    if (i === 0) {
      indices.push(currIdx + 0, currIdx + 2, currIdx + 1);
      indices.push(currIdx + 1, currIdx + 2, currIdx + 3);
    }

    if (i > 0) {
      const prev = 4 * (i - 1);
      indices.push(prev + 0, prev + 1, currIdx + 0);
      indices.push(prev + 1, currIdx + 1, currIdx + 0);
      indices.push(prev + 2, currIdx + 2, prev + 3);
      indices.push(prev + 3, currIdx + 2, currIdx + 3);
      indices.push(prev + 0, currIdx + 0, prev + 2);
      indices.push(prev + 2, currIdx + 0, currIdx + 2);
      indices.push(prev + 1, prev + 3, currIdx + 1);
      indices.push(prev + 3, currIdx + 3, currIdx + 1);
    }

    if (i === points.length - 1 && i > 0) {
      indices.push(currIdx + 0, currIdx + 1, currIdx + 2);
      indices.push(currIdx + 1, currIdx + 3, currIdx + 2);
    }
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
}

const ManholeMesh = forwardRef<THREE.Mesh, { mat: THREE.MeshStandardMaterial;[key: string]: any }>(
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
        <mesh position={[0, -THICKNESS / 2, 0]} material={mat}>
          <latheGeometry args={[lathePoints, 128]} />
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

type SceneProps = {
  trigger: boolean;
  material?: Material;
}

export function Scene({ trigger, material = 'metal' }: SceneProps) {
  const { gl, camera, size, scene } = useThree()
  const exportGroupRef = useRef<THREE.Group>(null!);
  const cameraPosRef = useRef<THREE.Vector3>(new THREE.Vector3());

  const baseMat = new THREE.MeshStandardMaterial({ ...materialOfColor[material] });

  useLayoutEffect(() => {
    if (!exportGroupRef.current) return;
    const cam = camera as THREE.PerspectiveCamera;
    fitObject(cam, exportGroupRef.current, 1.1);
    cam.updateProjectionMatrix();
    cameraPosRef.current.copy(cam.position);
  }, [camera, exportGroupRef.current]);

  useEffect(() => {
    if (!trigger) return;
    exportGroupToGLB(exportGroupRef.current);

    const cam = camera as THREE.PerspectiveCamera;
    const prev = { ...size, cam: { ...cam.position } }

    gl.setSize(512, 512);
    cam.position.copy(cameraPosRef.current);
    camera.lookAt(0, 0, 0);
    cam.aspect = 1;
    cam.updateProjectionMatrix();

    gl.render(scene, cam);
    gl.domElement.toBlob((blob) => {
      if (!blob) return;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'screenshot.png';
      a.click();

      URL.revokeObjectURL(url);
    }, 'image/png');

    gl.setSize(prev.width, prev.height);
    cam.position.copy(prev.cam);
    cam.aspect = prev.width / prev.height;
    cam.updateProjectionMatrix();
    gl.render(scene, cam);

  }, [trigger]);

  const convexGroupRef = useRef<THREE.Group>(null!);
  const concaveGroupRef = useRef<THREE.Group>(null!);
  const editMeshRef = useRef<THREE.Mesh>(null!);

  useEffect(() => {
    if (!editMeshRef.current || !concaveGroupRef.current) return;
    const mesh = new THREE.Mesh(
      editMeshRef.current.geometry.clone(),
      baseMat.clone()
    );
    mesh.position.copy(editMeshRef.current.position);
    mesh.position.y += 0.1;
    mesh.rotation.copy(editMeshRef.current.rotation);
    mesh.updateMatrixWorld();

    concaveGroupRef.current.add(mesh);
  }, []);

  const [isDrawing, setIsDrawing] = useState(false);
  const drawingMeshRef = useRef<THREE.Mesh>(null!);
  const pointsRef = useRef<THREE.Vector2Like[]>([]);
  const isPointsUpdateRef = useRef(false);

  const pushCommand = useStore(s => s.pushCommand);

  const { postCsgWorker, postIslWorker } = useWebWorker();

  const applySubtraction = async (targetMesh: THREE.Mesh, convexMesh: THREE.Mesh) => {
    targetMesh.updateMatrixWorld(true);
    convexMesh.updateMatrixWorld(true);

    const targetGeo = BufferGeometryUtils.mergeVertices(targetMesh.geometry.clone());
    targetGeo.applyMatrix4(targetMesh.matrixWorld);

    const cutterGeo = BufferGeometryUtils.mergeVertices(convexMesh.geometry.clone());
    cutterGeo.applyMatrix4(convexMesh.matrixWorld);

    try {
      const res = await postCsgWorker(targetGeo, cutterGeo, 'sub');

      if (res.success && res.result) {
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.result.position), 3));
        newGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(res.result.normal), 3));
        if (res.result.index) {
          newGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(res.result.index), 1));
        }

        if (targetMesh.parent) {
          const inverseParentMat = targetMesh.parent.matrixWorld.clone().invert();
          newGeo.applyMatrix4(inverseParentMat);
        }

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

  const getSeparateMeshes = async (mesh: THREE.Mesh) => {
    const res = await postIslWorker(mesh);
    if (!res.success || !res.result) return null;

    const meshArr: THREE.Mesh[] = [];
    for (const { position, normal } of res.result) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      const newMesh = new THREE.Mesh(geo, (mesh.material as THREE.MeshStandardMaterial).clone());
      newMesh.castShadow = true;
      newMesh.receiveShadow = true;
      meshArr.push(newMesh);
    }
    return meshArr;
  }

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
    setIsDrawing(false);

    if (pointsRef.current.length < 2) {
      if (drawingMeshRef.current) {
        drawingMeshRef.current.geometry.deleteAttribute('position');
        drawingMeshRef.current.geometry.setIndex(null);
      }
      return;
    }

    const geo = new THREE.BufferGeometry();
    updateGeometry(geo, pointsRef.current);
    const convexMesh = new THREE.Mesh(geo);
    convexMesh.position.copy(drawingMeshRef.current.position);
    convexMesh.rotation.copy(drawingMeshRef.current.rotation);
    convexMesh.updateMatrixWorld(true);

    const concaveParent = concaveGroupRef.current;

    const currentMeshes = concaveParent.children.filter(o => o instanceof THREE.Mesh) as THREE.Mesh[];
    const originalState = [...currentMeshes]; // Undo用

    let anyChanged = false;
    const nextMeshes: THREE.Mesh[] = [];
    const targetsToRemove: THREE.Mesh[] = [];

    for (const mesh of currentMeshes) {
      if (checkCollision(mesh, convexMesh)) {
        anyChanged = true;
        targetsToRemove.push(mesh);

        const subMesh = await applySubtraction(mesh, convexMesh);
        if (subMesh) {
          const separated = await getSeparateMeshes(subMesh);
          if (separated && separated.length > 0) nextMeshes.push(...separated);
          subMesh.geometry.dispose();
        }
      } else {
        nextMeshes.push(mesh);
      }
    }

    if (anyChanged) {
      concaveParent.remove(...targetsToRemove);
      concaveParent.add(...nextMeshes);
      convexGroupRef.current.add(convexMesh);

      const command: Command = {
        undo: () => {
          convexGroupRef.current.remove(convexMesh);
          concaveParent.remove(...nextMeshes);
          concaveParent.add(...originalState);
        },
        redo: () => {
          convexGroupRef.current.add(convexMesh);
          concaveParent.remove(...originalState);
          concaveParent.add(...nextMeshes);
        },
        dispose: () => {
          nextMeshes.forEach(m => meshAttrDispose(m));
          convexMesh.geometry.dispose();
        }
      };
      pushCommand(command);
    } else {
      geo.dispose();
    }

    pointsRef.current = [];
    drawingMeshRef.current.geometry.deleteAttribute('position');
    drawingMeshRef.current.geometry.setIndex(null);

    console.log(nextMeshes);
  };

  useFrame(() => {
    if (isDrawing && isPointsUpdateRef.current && drawingMeshRef.current) {
      updateGeometry(drawingMeshRef.current.geometry, pointsRef.current);
      isPointsUpdateRef.current = false;
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 20, 0]} fov={45} />
      <OrbitControls makeDefault enableRotate={!isDrawing} />

      <ambientLight color={0xffffff} intensity={1} />
      <directionalLight position={[0, 5, 0]} intensity={0.4} />

      <group ref={exportGroupRef}>
        <ManholeMesh
          ref={editMeshRef}
          mat={baseMat}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={handleFinDrawing}
          onPointerLeave={handleFinDrawing}
        />

        <group ref={convexGroupRef}></group>
        <group
          ref={concaveGroupRef}
          onClick={(e) => {
            // ① クリックされた「一番手前のメッシュ」はこれ
            const clickedMesh = e.object as THREE.Mesh;
            console.log(clickedMesh);
            (clickedMesh.material as THREE.MeshStandardMaterial).color.set(0xff0000);

            // ③ 貫通した「すべてのオブジェクト」の情報（距離順）
            // const allIntersections = e.intersections;
          }}
        ></group>

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