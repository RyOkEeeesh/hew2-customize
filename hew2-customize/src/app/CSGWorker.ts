/// <reference lib="webworker" />

import * as THREE from "three";
import * as CSG from "three-bvh-csg";
import type { CSGMsg } from "./types";

const evaluator = new CSG.Evaluator();

self.onmessage = (e: MessageEvent<CSGMsg>) => {
  try {
    const { type, obj } = e.data;

    const createGeo = (
      pos: THREE.TypedArray,
      norm: THREE.TypedArray,
      index?: THREE.TypedArray,
    ) => {
      const geo = new THREE.BufferGeometry();

      const posAttr = pos instanceof Float32Array ? pos : new Float32Array(pos);
      const normAttr =
        norm instanceof Float32Array ? norm : new Float32Array(norm);

      geo.setAttribute("position", new THREE.BufferAttribute(posAttr, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(normAttr, 3));

      if (index) {
        const indexAttr =
          index instanceof Uint32Array ? index : new Uint32Array(index);
        geo.setIndex(new THREE.BufferAttribute(indexAttr, 1));
      }

      const uvCount = pos.length / 3;
        const uvs = new Float32Array(uvCount * 2);
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

      return geo;
    };

    const geoA = createGeo(obj.positionA, obj.normalA, obj.indexA);
    const geoB = createGeo(obj.positionB, obj.normalB, obj.indexB);


    const brushA = new CSG.Brush(geoA);
    const brushB = new CSG.Brush(geoB);

    brushA.updateMatrixWorld();
    brushB.updateMatrixWorld();

    const opType =
      type === "union"
        ? CSG.ADDITION
        : type === "sub"
          ? CSG.SUBTRACTION
          : CSG.INTERSECTION;

    const resultMesh = evaluator.evaluate(brushA, brushB, opType);
    const resultGeo = resultMesh.geometry;

    // position は必ず取得できると仮定しつつ、安全策としてチェック
    const positionAttr = resultGeo.getAttribute("position");
    const position = positionAttr
      ? (positionAttr.array as Float32Array)
      : new Float32Array(0);

    // normal が存在しない場合（結果が空の場合など）に備える
    const normalAttr = resultGeo.getAttribute("normal");
    const normal = normalAttr
      ? (normalAttr.array as Float32Array)
      : new Float32Array(0);

    const index = resultGeo.index
      ? (resultGeo.index.array as Uint32Array)
      : null;

    // 転送可能オブジェクトのリストを作成
    const transfer: ArrayBufferLike[] = [];
    if (position.buffer) transfer.push(position.buffer);
    if (normal.buffer) transfer.push(normal.buffer);
    if (index?.buffer) transfer.push(index.buffer);

    self.postMessage(
      {
        success: true,
        result: { position, normal, index },
      },
      transfer,
    );

    geoA.dispose();
    geoB.dispose();
    resultGeo.dispose();
  } catch (err: any) {
    console.error("CSGworker error:", err);
    self.postMessage({
      success: false,
      error: err?.message ?? "Unknown error",
    });
  }
};
