import { Mutex } from 'async-mutex';

const STAR_FRAME_DELAYS = [650, 120, 120, 120, 120, 120, 120];
export const SILENT_MSG_LEVEL = 0;
export const LOG_MSG_LEVEL = 1;
export const ERR_MSG_LEVEL = 2;

var catchMessageLevel = ERR_MSG_LEVEL;
var persistingActiveListener = false;

const GAL = new Mutex();
var loadLocked = false;

function smartLog(err: any) {
    if (catchMessageLevel == LOG_MSG_LEVEL) 
        console.log(err);
    else if (catchMessageLevel == ERR_MSG_LEVEL)
        console.error(err);
}

export function setLogLevel(level: number) {
    catchMessageLevel = level;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
  
async function changeFavicon(tabId: number, newUrl: string) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (newUrl) => {
        let link = document.querySelector("link[rel~='icon']") 
                || document.createElement("link");
        link.setAttribute("rel", "icon");
        link.setAttribute("href", newUrl);
        document.head.appendChild(link);
    },
    args: [newUrl]
});
}

async function tabIsActive(tabId: number) {
  return Boolean(((await chrome.tabs.query({active: true, currentWindow: true})
    .catch(() => null)))?.map((t) => t.id).includes(tabId));
}

async function runAnimationLocal(tabId: number, frameDelays: number[], basepath: string, ext: string, fileStartNum: number) {
  for (let i = 0; i < frameDelays.length; i++) {
    if (!await tabIsActive(tabId) || loadLocked)
      break;
    await changeFavicon(tabId, chrome.runtime.getURL(basepath + `${fileStartNum + i}${ext}`)).catch();
    await delay(frameDelays[i] * 0.9);
  }
}

export async function faviconFromURL(url: string): Promise<string | undefined> {
  return await fetch(`https://www.google.com/s2/favicons?domain=${url}&sz=32`)
  .then(response => response.url)
  .catch(() => undefined);
}

export async function resetIcons(tab: chrome.tabs.Tab) {
    if (tab) {
      await chrome.scripting.executeScript(
        { target: { tabId: tab.id! },
          func: () => {
            document.querySelectorAll('link[rel*="icon"]')
                .forEach(link => link.remove());
          }
        },
      );
    }
  }

async function starAnimation(tabId: number) {
  await GAL.waitForUnlock();
  loadLocked = false;
  if (!await tabIsActive(tabId)) {
    return GAL.release();
  }
  const tab: chrome.tabs.Tab | null = await chrome.tabs.get(tabId).catch(() => null);
  if (!(tab)?.url?.startsWith("http")) {
    return GAL.release();
  }
  const release = await GAL.acquire();
  try {
    await resetIcons(await chrome.tabs.get(tabId)).catch(); // Not worth raising error
    while (await tabIsActive(tabId) && !loadLocked) {
        await runAnimationLocal(tabId, STAR_FRAME_DELAYS, "public/docked_star", ".png", 1);
    }
  } catch (e) {
    smartLog("Animation err: " + e);
  } finally {
      if (await chrome.tabs.get(tabId).catch(() => null)) {
        const oldURL = await faviconFromURL(tab.url!).catch((e) => smartLog(e));
        if (oldURL) {
            await changeFavicon(tabId, oldURL).catch((e) => smartLog(e));
        }
      }
      release();
  }
}

export function addUpdateTabListener() {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) =>  {
        if (!await tabIsActive(tabId) && persistingActiveListener) return;
        if (changeInfo.status == "complete")
            await starAnimation(tabId);
        else if (changeInfo.status == "loading")
            loadLocked = true;
    });
}

export function addActiveTabListener() {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        await starAnimation(activeInfo.tabId);
    });
    persistingActiveListener = true;
    addUpdateTabListener();
    
}
    