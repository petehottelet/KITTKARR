// Revision 4. Declare camera access for the user-requested local Yautja mode.
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const app=path.join(root,'.kitt-state/KITT.app'),contents=path.join(app,'Contents');
await mkdir(path.join(contents,'MacOS'),{recursive:true,mode:0o700});
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const values={CFBundleIdentifier:'com.carthing.kitt.microphone',CFBundleName:'KITT',CFBundleDisplayName:'KITT',CFBundleExecutable:'KITT',CFBundlePackageType:'APPL',CFBundleShortVersionString:'1.2',CFBundleVersion:'3',NSCameraUsageDescription:'Yautja mode shows your webcam locally on the Car Thing with thermal-style colors. The camera stops when you leave that screen.',NSMicrophoneUsageDescription:'KITT uses your selected AirPods or Mac microphone for local wake words and voice requests.',KittNodeExecutable:process.execPath,KittProjectDirectory:root};
await writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'+Object.entries(values).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')+'<key>LSUIElement</key><true/></dict></plist>');
await run('/usr/bin/xcrun',['swiftc','-module-cache-path',path.join(root,'.kitt-state/swift-module-cache'),path.join(root,'assistant/mac-host-v1.swift'),'-o',path.join(contents,'MacOS/KITT')],{timeout:120000});
await run('/usr/bin/codesign',['--force','--sign','-','--identifier','com.carthing.kitt.microphone',app],{timeout:15000});
console.log('Built '+app);
