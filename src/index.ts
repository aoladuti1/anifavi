import { Mutex } from 'async-mutex';
import { decodeFrames, encode } from 'modern-gif';

/** A string with Base64 data */
export type Base64String = string;
export type URIString = string;

export type FrameInfo = {
  data: Base64String;
  delay: number;
}

export type AnimationOptions = {
  ruleFunc?: ((tabId: number) => Promise<Boolean>);
  evolveFunc?: ((frameIndex: number, frameInfo: FrameInfo) => Promise<FrameInfo>);
  numLoops?: number;
  revertFavicon?: Boolean;
  defaultFaviconInput?: Base64String | URIString;
  bypassMutex?: Boolean;
}

export type FrameInfoMods = {
  rewindOnEnd?: Boolean;
  rewindOnEndAlt?: Boolean;
  delayMultiplier?: number;
}

export const SILENT_MSG_LEVEL = 0;
export const LOG_MSG_LEVEL = 1;
export const WARN_MSG_LEVEL = 2;
export const ERR_MSG_LEVEL = 3;

export const DEFAULT_MODS_DELAY_MULTIPLIER = 0.85;
export const PLACEHOLDER_FAVICON_INPUT = "https://cdn-icons-png.freepik.com/128/10259/10259740.png";

const GAL = new Mutex();
var catchMessageLevel = WARN_MSG_LEVEL;
var cancel = false;
var basicActivatedListener: (activeInfo: chrome.tabs.TabActiveInfo) => Promise<void>;
var basicUpdatedListener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => Promise<void>;

export function toBase64(buffer: ArrayBuffer): string {
  const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const byteLength = buffer.byteLength;
  const bufferView = new Uint8Array(buffer);
  const remainingBytesCount = byteLength % 3;
  const mainLength = byteLength - remainingBytesCount;
  let string = "";
  let i = 0;
  for (; i < mainLength; i += 3) {
    const chunk = (bufferView[i] << 16) | (bufferView[i + 1] << 8) | bufferView[i + 2];
    string += base64Chars[(chunk & 0b111111000000000000000000) >> 18];
    string += base64Chars[(chunk & 0b000000111111000000000000) >> 12];
    string += base64Chars[(chunk & 0b000000000000111111000000) >> 6];
    string += base64Chars[(chunk & 0b000000000000000000111111)];
  }
  if (remainingBytesCount === 2) {
    const chunk = (bufferView[i] << 16) | (bufferView[i + 1] << 8);
    string += base64Chars[(chunk & 0b111111000000000000000000) >> 18];
    string += base64Chars[(chunk & 0b000000111111000000000000) >> 12];
    string += base64Chars[(chunk & 0b000000000000111111000000) >> 6];
    string += "=";
  } else if (remainingBytesCount === 1) {
    const chunk = (bufferView[i] << 16);
    string += base64Chars[(chunk & 0b111111000000000000000000) >> 18];
    string += base64Chars[(chunk & 0b000000111111000000000000) >> 12];
    string += "==";
  }
  return string;
}

function smartLog(err: any) {
  if (catchMessageLevel === LOG_MSG_LEVEL)
    console.log(err);
  else if (catchMessageLevel === WARN_MSG_LEVEL)
    console.warn(err);
  else if (catchMessageLevel === ERR_MSG_LEVEL)
    console.error(err);
}

export async function loadImage(input: string | URL | globalThis.Request): Promise<ArrayBuffer> {
  let buffer = await fetch(input).then(res => res.arrayBuffer());
  if (buffer == null) {
    throw new Error("Could not read image at " + input);
  } else {
    return buffer;
  }
}

export async function getFramesInfo(loadedGIF: ArrayBuffer): Promise<FrameInfo[]> {
  let ret = [];
  for (const frame of decodeFrames(loadedGIF)) {
    let data = await encode({
      frames: [{ data: frame.data, /* delay: frame.delay */ }],
      width: frame.width,
      height: frame.height
    })
    ret.push({ data: toBase64(data), delay: frame.delay });
  }
  return ret;
}

/**
 * Set the console log level to either ```SILENT_MSG_LEVEL``` (0),
 * ```LOG_MSG_LEVEL``` (1),
 * ```WARN_MSG_LEVEL``` (2), or
 * ```ERR_MSG_LEVEL``` (3).
 * Default is ```WARN_MSG_LEVEL```.
 * @param level 
 */
export function setLogLevel(level: number) {
  catchMessageLevel = level;
}

export function getLogLevel() {
  return catchMessageLevel;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function applyDefaultModifications(framesInfo: FrameInfo[]) {
  return await modifyFramesInfo(framesInfo, {delayMultiplier: DEFAULT_MODS_DELAY_MULTIPLIER});
}

export async function changeFavicon(tabId: number, data: Base64String | URIString) {
  let isBase64 = !data.substring(0, 10).includes(":", 4);
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (data, isBase64) => {
      let newUrl = data;
      if (isBase64) {
        const b64toBlob = (b64Data: string, contentType = 'image/gif', sliceSize = 64) => {
          const byteCharacters = atob(b64Data);
          const byteArrays = [];
          for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
              byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
          }
          const blob = new Blob(byteArrays, { type: contentType });
          return blob;
        }
        newUrl = (window.URL ? URL : webkitURL).createObjectURL(b64toBlob(newUrl as string));
      }
      let link = document.querySelector("link[rel~='icon']")
        || document.createElement("link");
      link.setAttribute("rel", "icon");
      link.setAttribute("href", newUrl as string);
      document.head.appendChild(link);
    },
    args: [data, isBase64]
  });
}

export async function tabIsActive(tabId: number) {
  return Boolean(
    ((await chrome.tabs.query({ active: true, currentWindow: true })
      .catch(() => null)))?.map((t) => t.id).includes(tabId));
}

async function renderOnceFromData(
    tabId: number,
    framesInfo: FrameInfo[],
    ruleFunc: ((tabId: number) => Promise<Boolean>),
    evolveFunc?: ((frameIndex: number, frameInfo: FrameInfo) => Promise<FrameInfo>)) {
  for (let i = 0; i < framesInfo.length; i++) {
    if (!await ruleFunc(tabId) || cancel)
      break;
    let frameInfo = framesInfo[i];
    if (evolveFunc)
      frameInfo = await evolveFunc(i, {...frameInfo});
    await changeFavicon(tabId, frameInfo.data);
    await removeIcon(tabId);
    await delay(frameInfo.delay);
  }
}

// sz=32 for retina displays, I guess
export async function getFaviconFromURL(url: string): Promise<string | undefined> {
  return await fetch(`https://www.google.com/s2/favicons?domain=${url}&sz=32`)
    .then(response => { if (response.ok) return response.url; });
}

export async function removeIcon(tabId: number) {
  if (tabId) {
    await chrome.scripting.executeScript(
      { target: { tabId: tabId },
        func: () => {
          document.querySelectorAll('link[rel*="icon"]')
            .forEach(link => link.remove());
        }
      } 
    )
  }
}

export async function getMutex() {
  return GAL;
}

async function waitForUnlock(bypassMutex: Boolean) {
  if (!bypassMutex) await GAL.waitForUnlock();
}

async function acquire(bypassMutex: Boolean) {
  if (!bypassMutex) return await GAL.acquire();
}

function release(bypassMutex: Boolean) {
  if (!bypassMutex) GAL.release();
}

export async function animate(
    tabId: number, framesInfo: FrameInfo[], options: AnimationOptions = {}) {
  let ruleFunc = options.ruleFunc ?? tabIsActive;
  let evolveFunc = options.evolveFunc;
  let numLoops = options.numLoops ?? Infinity;
  let revertFavicon = options.revertFavicon ?? true;
  let defaultFaviconInput = options.defaultFaviconInput ?? PLACEHOLDER_FAVICON_INPUT;
  let bypassMutex = options.bypassMutex ?? false;
  await waitForUnlock(bypassMutex);
  cancel = false;
  if (!await ruleFunc(tabId)) {
    return release(bypassMutex);
  }
  const tab = await chrome.tabs.get(tabId);
  if (!(tab)?.url?.startsWith("http")) {
    return release(bypassMutex);
  }
  await acquire(bypassMutex);
  try {
    await removeIcon(tabId).catch((err) => { 
      if (revertFavicon)
        throw err; 
    });
    for (let i = 0; i <= numLoops && ((await ruleFunc(tabId)) && !cancel); i++) {
      await renderOnceFromData(tabId, framesInfo, ruleFunc, evolveFunc);
    }
  } catch (e) {
    smartLog("Animation err: " + e);
  } finally {
    if (revertFavicon) {
      let tabNewer = await chrome.tabs.get(tabId).catch(()=>null);
      if (!tabNewer) return release(bypassMutex);
      try {
      const oldURL = await getFaviconFromURL(tabNewer.url!);
      if (oldURL) {
        await changeFavicon(tabId, oldURL).catch(
          async (err) => { await removeIcon(tabId); throw err; });
      } else {
        await changeFavicon(tabId, defaultFaviconInput);
      }
    } catch(e) {smartLog(`Failed to revert favicon for tab with url ${tab.url}, ${e}`)}
    }
    release(bypassMutex);
  }
}

export function tryCancelAnimations() {
  cancel = true;
}

export function modifyFramesInfo(
    framesInfo: FrameInfo[], changes: FrameInfoMods = {}) {
  let delayMultiplier = changes.delayMultiplier ?? 1;
  let rewindOnEnd = changes.rewindOnEnd ?? false;
  let rewindOnEndAlt = changes.rewindOnEndAlt ?? false;
  let modFramesInfo = framesInfo.slice(0);
  rewindOnEnd = rewindOnEnd || rewindOnEndAlt;
  if (delayMultiplier != 1) {
    for (let i = 0; i < modFramesInfo.length; i++)
      modFramesInfo[i].delay *= delayMultiplier;
  }
  if (rewindOnEndAlt)
    modFramesInfo.push(modFramesInfo[0]);
  if (rewindOnEnd) {
    modFramesInfo = modFramesInfo.concat(modFramesInfo.slice(0).reverse());
  }
  return modFramesInfo;
}

export function addBasicAnimators(
  framesInfo: FrameInfo[],
  animationOptions: AnimationOptions = {}) {
  basicActivatedListener = async (activeInfo: chrome.tabs.TabActiveInfo) => {
      await animate(activeInfo.tabId, framesInfo);
  };
  basicUpdatedListener = async (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      let theTabIsActive: Boolean = await tabIsActive(tabId);
      if (!theTabIsActive || !framesInfo) return;
      if (changeInfo.status == "complete") {
          await animate(tabId, framesInfo, animationOptions);
      } else if (changeInfo.status == "loading") {
          tryCancelAnimations();
      }
  };
  chrome.tabs.onActivated.addListener(basicActivatedListener);
  chrome.tabs.onUpdated.addListener(basicUpdatedListener);
}

export function removeBasicAnimators() {
  if (basicActivatedListener) {
      chrome.tabs.onActivated.removeListener(basicActivatedListener);
  }
  if (basicUpdatedListener) {
      chrome.tabs.onUpdated.removeListener(basicUpdatedListener);
  }
}


