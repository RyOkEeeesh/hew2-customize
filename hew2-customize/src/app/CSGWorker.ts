/// <reference lib="webworker" />

import { CSG } from 'three-csg-ts';
import * as THREE from 'three';

export type CSGType = 'union' | 'sub' | 'intersect';

export type CSGMsg = {
  type: CSGType;
  obj: {
    positionA: THREE.TypedArray;
    normalA: THREE.TypedArray;
    indexA?: THREE.TypedArray;
    positionB: THREE.TypedArray;
    normalB: THREE.TypedArray;
    indexB?: THREE.TypedArray;
  };
};

self.onmessage = (e: MessageEvent<CSGMsg>) => {
  try {
    const { type, obj } = e.data;

    const geoA = new THREE.BufferGeometry();
    geoA.setAttribute('position', new THREE.BufferAttribute(new Float32Array(obj.positionA), 3));
    geoA.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(obj.normalA), 3));
    if (obj.indexA) geoA.setIndex(new THREE.BufferAttribute(new Uint32Array(obj.indexA), 1));

    const geoB = new THREE.BufferGeometry();
    geoB.setAttribute('position', new THREE.BufferAttribute(new Float32Array(obj.positionB), 3));
    geoB.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(obj.normalB), 3));
    if (obj.indexB) geoB.setIndex(new THREE.BufferAttribute(new Uint32Array(obj.indexB), 1));

    const meshA = new THREE.Mesh(geoA);
    const meshB = new THREE.Mesh(geoB);

    meshA.updateMatrixWorld();
    meshB.updateMatrixWorld();
    geoA.applyMatrix4(meshA.matrixWorld);
    geoB.applyMatrix4(meshB.matrixWorld);

    const result =
      type === 'union'
        ? CSG.union(meshA, meshB)
        : type === 'sub'
          ? CSG.subtract(meshA, meshB)
          : CSG.intersect(meshA, meshB);

    const resultGeo = result.geometry.toNonIndexed();

    const position = resultGeo.getAttribute('position')?.array as Float32Array;
    const normal = resultGeo.getAttribute('normal')?.array as Float32Array;
    const index = resultGeo.index ? (resultGeo.index.array as Uint32Array) : null;

    const transfer: ArrayBufferLike[] = [];
    if (position) transfer.push(position.buffer);
    if (normal) transfer.push(normal.buffer);
    if (index) transfer.push(index.buffer);

    self.postMessage(
      {
        success: true,
        result: { position, normal, index },
      },
      transfer
    );
  } catch (err: any) {
    console.error('CSG worker error:', err);
    self.postMessage({
      success: false,
      error: err?.message ?? 'Unknown error',
    });
  }
};
