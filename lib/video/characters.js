"use strict";
// 0.6.44：角色库（固定人物形象）。纯 Node，单测不用 Electron。
// 每个角色一个目录：<videoDir>/characters/<id>/character.json + 图片文件。
// 角色 = 名字 + 外貌锚点（脸、五官、发型等不随镜头变的特征）+ 服装 + 参考图（三视图、面部特写、其他）。
// 生图（网页手动或 Seedream API）时，锚点文字 + 参考图一起用，保证每张图是同一个人。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KINDS = ["sheet", "face", "frame", "other"];
const KIND_LABELS = { sheet: "三视图", face: "面部特写", frame: "镜头首帧", other: "参考图" };
const IMG_EXT = /\.(png|jpe?g|webp)$/i;

const str = (v, n) => String(v == null ? "" : v).replace(/\u0000/g, "").trim().slice(0, n);

function normalize(o = {}) {
  const images = (Array.isArray(o.images) ? o.images : []).map((x) => ({
    file: path.basename(str(x && x.file, 200)),
    kind: KINDS.includes(x && x.kind) ? x.kind : "other",
    note: str(x && x.note, 200),
    createdAt: Number(x && x.createdAt) || Date.now(),
  })).filter((x) => IMG_EXT.test(x.file));
  return {
    id: str(o.id, 64),
    name: str(o.name, 60) || "未命名角色",
    anchor: str(o.anchor, 1500),
    outfit: str(o.outfit, 1000),
    notes: str(o.notes, 1000),
    images,
    cover: images.some((x) => x.file === o.cover) ? o.cover : (images.find((x) => x.kind === "face") || images.find((x) => x.kind === "sheet") || images[0] || {}).file || "",
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Date.now(),
  };
}

function createCharacterStore({ dir }) {
  const safeId = (id) => (/^[a-z0-9-]{4,64}$/i.test(String(id || "")) ? String(id) : "");
  const cdir = (id) => path.join(dir, safeId(id));
  const jsonOf = (id) => path.join(cdir(id), "character.json");
  function get(id) {
    if (!safeId(id)) return null;
    try { return normalize(JSON.parse(fs.readFileSync(jsonOf(id), "utf8"))); } catch { return null; }
  }
  function write(c) {
    fs.mkdirSync(cdir(c.id), { recursive: true });
    fs.writeFileSync(jsonOf(c.id), JSON.stringify(c, null, 2));
    return c;
  }
  function list() {
    let ids = [];
    try { ids = fs.readdirSync(dir).filter((n) => safeId(n)); } catch { ids = []; }
    return ids.map(get).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function save(input = {}) {
    const old = input.id ? get(input.id) : null;
    const id = old ? old.id : `c-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const merged = normalize({ ...(old || {}), ...input, id, images: old ? old.images : [], cover: input.cover || (old && old.cover), createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now() });
    return write(merged);
  }
  function remove(id) {
    if (!get(id)) return false;
    fs.rmSync(cdir(id), { recursive: true, force: true });
    return true;
  }
  function imagePath(id, file) {
    const c = get(id);
    const f = path.basename(String(file || ""));
    if (!c || !c.images.some((x) => x.file === f)) return "";
    const abs = path.join(cdir(id), f);
    return fs.existsSync(abs) ? abs : "";
  }
  // bytes: Buffer；ext: png/jpg/webp
  function addImage(id, bytes, { kind = "other", note = "", ext = "png" } = {}) {
    const c = get(id);
    if (!c) throw new Error("角色不存在");
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("图片是空的");
    const e = /^(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase().replace("jpeg", "jpg") : "png";
    const file = `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}.${e}`;
    fs.writeFileSync(path.join(cdir(id), file), bytes);
    c.images.push({ file, kind: KINDS.includes(kind) ? kind : "other", note: str(note, 200), createdAt: Date.now() });
    const curCover = c.images.find((x) => x.file === c.cover);
    if (!curCover || (kind === "face" && curCover.kind !== "face")) c.cover = file;
    c.updatedAt = Date.now();
    write(normalize(c));
    return file;
  }
  function removeImage(id, file) {
    const c = get(id);
    const f = path.basename(String(file || ""));
    if (!c) return false;
    c.images = c.images.filter((x) => x.file !== f);
    try { fs.unlinkSync(path.join(cdir(id), f)); } catch { /* ignore */ }
    if (c.cover === f) c.cover = "";
    c.updatedAt = Date.now();
    write(normalize(c));
    return true;
  }
  function update(id, patch = {}) {
    const c = get(id);
    if (!c) return null;
    if (patch.cover) c.cover = path.basename(patch.cover);
    if (patch.imageKind) {
      const im = c.images.find((x) => x.file === path.basename(patch.imageKind.file || ""));
      if (im && KINDS.includes(patch.imageKind.kind)) im.kind = patch.imageKind.kind;
    }
    c.updatedAt = Date.now();
    return write(normalize(c));
  }
  // 生图时用作参考的图：三视图和面部特写优先，最多 n 张
  function referenceFiles(id, n = 4) {
    const c = get(id);
    if (!c) return [];
    const order = { face: 0, sheet: 1, other: 2, frame: 3 };
    return c.images.filter((x) => x.kind !== "frame").sort((a, b) => order[a.kind] - order[b.kind] || b.createdAt - a.createdAt)
      .slice(0, n).map((x) => path.join(cdir(id), x.file)).filter((p) => fs.existsSync(p));
  }
  return { list, get, save, remove, addImage, removeImage, imagePath, update, referenceFiles, dirOf: cdir };
}

// ---- 提示词 ----
const who = (c) => [c.anchor && `外貌：${c.anchor}`, c.outfit && `服装：${c.outfit}`].filter(Boolean).join("；");

function sheetPrompt(c, { refs = 0 } = {}) {
  return [
    `角色设定三视图，${refs ? "参考图中的同一个人，脸型五官发型完全保持一致，" : ""}同一人物的正面、侧面、背面全身站立像并排，外加一个面部特写，`,
    who(c) + "。",
    "纯白背景，平光均匀照明，自然站姿双臂微微下垂，人物比例和服装细节三个角度完全一致，写实摄影质感，高清细节，不要文字、不要水印、不要多余人物。",
  ].join("");
}

function facePrompt(c, { refs = 0 } = {}) {
  return [
    `人物面部特写证件照风格，${refs ? "参考图中的同一个人，脸型五官发型完全保持一致，" : ""}正面平视，`,
    who(c) + "。",
    "表情平静自然，柔和正面光，浅灰纯色背景，清晰展示五官、皮肤质感和发型，写实摄影，高清，不要文字、不要水印。",
  ].join("");
}

// 一镜的首帧图：角色锚点 + 这镜的画面提示词（去掉其中对人物外貌的重复也没关系，锚点优先）
function framePrompt(c, shotPrompt, { refs = 0, aspect = "", style = "" } = {}) {
  const p = str(shotPrompt, 1500).replace(/\n?风格[:：][\s\S]*$/, "").trim();
  return [
    aspect ? `${aspect}画面，` : "",
    "视频首帧静态画面。",
    refs ? "画面中的人物就是参考图里的同一个人：脸型、五官、发型发色、肤色完全保持一致，不要换脸。" : "",
    `人物${who(c)}。`,
    p ? `画面内容：${p}` : "",
    style ? `\n风格：${str(style, 600)}` : "",
    "\n只画这一瞬间的静态画面，人物清晰不糊，不要文字、不要水印。",
  ].join("");
}

module.exports = { createCharacterStore, normalize, sheetPrompt, facePrompt, framePrompt, KINDS, KIND_LABELS };
