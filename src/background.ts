// This file contains the background script for the extension. It manages the lifecycle of the extension and can handle events such as opening the persistent window.

chrome.runtime.onInstalled.addListener(() => {
    chrome.windows.create({
        url: chrome.runtime.getURL("window.html"),
        type: "popup",
        width: 400,
        height: 600,
        focused: true
    });
});