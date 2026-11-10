"use strict";
// 0.6.44：角色库（固定人物形象）。纯 Node，单测不用 Electron。
// 每个角色一个目录：<videoDir>/characters/<id>/character.json + 图片文件。
// 角色 = 名字 + 外貌锚点（脸、五官、发型等不随镜头变的特征）+ 服装 + 参考图（三视图、面部特写、其他）。
// 生图（网页手动或 Seedream API）时，锚点文字 + 参考图一起用，保证每张图是同一个人。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 0.6.56：同一个库也存场景（type: "scene"）。场景图：wide 全景、angle 多角度/细节
const KINDS = ["sheet", "face", "frame", "other", "wide", "angle"];
const KIND_LABELS = { sheet: "三视图", face: "面部特写", frame: "镜头首帧", other: "参考图", wide: "场景全景", angle: "场景多角度" };
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
    type: o.type === "scene" ? "scene" : "character",
    name: str(o.name, 60) || (o.type === "scene" ? "未命名场景" : "未命名角色"),
    anchor: str(o.anchor, 1500),
    outfit: str(o.outfit, 1000),
    notes: str(o.notes, 1000),
    images,
    cover: images.some((x) => x.file === o.cover) ? o.cover : (images.find((x) => x.kind === "face" || x.kind === "wide") || images.find((x) => x.kind === "sheet") || images[0] || {}).file || "",
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
  function list(type) {
    let ids = [];
    try { ids = fs.readdirSync(dir).filter((n) => safeId(n)); } catch { ids = []; }
    return ids.map(get).filter((c) => c && (!type || c.type === type)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function save(input = {}) {
    const old = input.id ? get(input.id) : null;
    const id = old ? old.id : `c-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const merged = normalize({ ...(old || {}), ...input, id, type: old ? old.type : input.type, images: old ? old.images : [], cover: input.cover || (old && old.cover), createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now() });
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
    if (!curCover || (kind === "face" && curCover.kind !== "face") || (kind === "wide" && curCover.kind !== "wide")) c.cover = file;
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
    const order = { face: 0, wide: 0, sheet: 1, angle: 1, other: 2, frame: 3 };
    return c.images.filter((x) => x.kind !== "frame").sort((a, b) => order[a.kind] - order[b.kind] || b.createdAt - a.createdAt)
      .slice(0, n).map((x) => path.join(cdir(id), x.file)).filter((p) => fs.existsSync(p));
  }
  return { list, get, save, remove, addImage, removeImage, imagePath, update, referenceFiles, dirOf: cdir };
}

// ---- 提示词 ----
// 0.6.60：没有参考图时按国内审美画人脸（用户反馈“像亚裔，不像中国人”）
const CN_FACE = "中国人长相，符合国内审美：五官精致协调，皮肤白皙干净通透，明亮有神的眼睛，鼻梁秀挺，唇形自然饱满，清透自然妆感，不要刻板的欧美式亚裔长相。";
const who = (c) => [c.anchor && `外貌：${c.anchor}`, c.outfit && `服装：${c.outfit}`].filter(Boolean).join("；");

function sheetPrompt(c, { refs = 0 } = {}) {
  return [
    `角色设定三视图（character turnaround sheet），${refs ? "参考图中的同一个人，脸型五官发型完全保持一致，" : ""}同一个人物从左到右等间距横排三个全身站立像：`,
    "左边是正面（面朝镜头），中间是正侧面（身体和脸转 90 度朝向画面左侧，只看到一边脸），右边是背面（完全背对镜头，看到后脑勺和背部）。",
    "三个都是从头顶到脚完整入画的全身像，同样大小、同一高度，不要半身、不要特写、不要三个都朝前。",
    who(c) + "。",
    refs ? "" : CN_FACE,
    "纯白背景，平光均匀照明，自然站姿双臂微微下垂，人物比例和服装细节三个角度完全一致，写实摄影质感，高清细节，不要文字、不要水印、不要多余人物。",
  ].join("");
}

function facePrompt(c, { refs = 0 } = {}) {
  return [
    `人物面部特写证件照风格，${refs ? "参考图中的同一个人，脸型五官发型完全保持一致，" : ""}正面平视，`,
    who(c) + "。",
    refs ? "" : CN_FACE,
    "表情平静自然，柔和正面光，浅灰纯色背景，清晰展示五官和发型，写实摄影，高清，不要文字、不要水印。",
  ].join("");
}

// 0.6.56：场景图（不出现人物）
const where = (s) => [s.anchor && `场景：${s.anchor}`, s.outfit && `光线与氛围：${s.outfit}`].filter(Boolean).join("；");
function scenePrompt(s, { kind = "wide", refs = 0, aspect = "", style = "" } = {}) {
  return [
    aspect ? `${aspect}画面，` : "",
    kind === "angle"
      ? `同一个场景的多角度设定图，${refs ? "和参考图是同一个地方，布局、陈设、材质、配色完全一致，" : ""}四宫格：正面全景、反打角度、侧面角度、一处标志性细节特写，`
      : `场景全景空镜，${refs ? "和参考图是同一个地方，布局、陈设、材质、配色完全一致，" : ""}视平线机位，完整展示空间布局，`,
    where(s) + "。",
    style ? `风格：${str(style, 600)}。` : "",
    "画面中不要出现任何人物，写实摄影质感，高清细节，不要文字、不要水印。",
  ].join("");
}

// 一镜的首帧图：角色锚点 + 这镜的画面提示词（去掉其中对人物外貌的重复也没关系，锚点优先）
// 0.6.56：可带场景 scene（场景参考图排在人物参考图后面）；c 为空时只有场景
function framePrompt(c, shotPrompt, { refs = 0, aspect = "", style = "", scene = null, sceneRefs = 0 } = {}) {
  const p = str(shotPrompt, 10000).replace(/\n?【风格】[^\n【]*/g, "").replace(/\n?风格[:：][\s\S]*$/, "").trim();
  return [
    aspect ? `${aspect}画面，` : "",
    "视频首帧静态画面。",
    c && refs ? `画面中的人物就是${sceneRefs ? "前几张" : ""}参考图里的同一个人：脸型、五官、发型发色、肤色完全保持一致，不要换脸。` : "",
    scene && sceneRefs ? `场景就是${c && refs ? "后几张" : ""}参考图里的同一个地方：布局、陈设、材质、配色保持一致。` : "",
    c ? `人物${who(c)}。` : "",
    c && !refs ? CN_FACE : "",
    scene ? `${where(scene)}。` : "",
    p ? `画面内容：${p}` : "",
    style ? `\n风格：${str(style, 600)}` : "",
    "\n只画这一瞬间的静态画面，人物清晰不糊，不要文字、不要水印。",
  ].join("");
}

module.exports = { createCharacterStore, normalize, sheetPrompt, facePrompt, framePrompt, scenePrompt, KINDS, KIND_LABELS };
