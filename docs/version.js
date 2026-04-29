// Single source of truth for the app version.
//
// Bump this number when shipping any change you want PWA users to pick up.
// Changing this file's bytes triggers two things automatically:
//
// 1. The service worker imports this file (importScripts), so its byte content
//    changes too, which makes the browser treat sw.js as a new service worker
//    → install, skipWaiting, activate, claim, controllerchange → page reload.
// 2. The client reads CELLAR_VERSION and renders it in the topbar, so what
//    you see on screen always matches the running shell.
//
// `self` works in both window and ServiceWorker global scope, so the same
// assignment is valid in both contexts.
self.CELLAR_VERSION = '0.5.2';
