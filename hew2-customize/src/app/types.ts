import * as THREE from "three";

export type CSGType = "union" | "sub" | "intersect";

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

export type CSGResult = {
  success: boolean;
  result?: {
    position: Float32Array;
    normal: Float32Array;
    index: Uint32Array | null;
  };
  error?: string;
};

export type IslMsg = {
  positions: THREE.TypedArray;
  normals: THREE.TypedArray;
};

export type IslResult = {
  success: boolean;
  result?: {
    position: Float32Array<ArrayBufferLike>;
    normal: Float32Array;
  }[];
  error?: string;
};