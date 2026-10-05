import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {root,verifyExecutable} from './packaging.mjs';
import {VERSION} from '../server/version.mjs';

export async function buildTray(bundle,platform=process.platform,arch=process.arch,{run=execFileSync,hostPlatform=process.platform}={}){
  if(platform!==hostPlatform)throw new Error('Build the tray on its target OS.');
  if(!(platform==='win32'&&arch==='x64')&&!(platform==='darwin'&&['x64','arm64'].includes(arch)))throw new Error('Tray supported on Windows x64 and macOS x64/arm64 only.');
  if(platform==='win32'){
    const compiler=join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    run(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',`/win32icon:${join(root,'tray/icon.ico')}`,`/out:${join(bundle,'LineBridge.exe')}`,join(root,'tray/windows.cs')],{stdio:'pipe',windowsHide:true});
    verifyExecutable(await readFile(join(bundle,'LineBridge.exe')),{platform,arch});
    return 'LineBridge.exe';
  }
  const contents=join(bundle,'LineBridge.app/Contents'),binary=join(contents,'MacOS/LineBridge');
  await mkdir(join(contents,'MacOS'),{recursive:true});
  await mkdir(join(contents,'Resources'),{recursive:true});
  await copyFile(join(root,'tray/icon.icns'),join(contents,'Resources/icon.icns'));
  run('/usr/bin/xcrun',['swiftc','-swift-version','5','-target',`${arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.5`,'-O','-framework','AppKit','-o',binary,join(root,'tray/macos.swift')],{stdio:'pipe'});
  verifyExecutable(await readFile(binary),{platform,arch});
  await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LineBridge</string><key>CFBundleIdentifier</key><string>com.ryantsai.linebridge.tray</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleName</key><string>LineBridge</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${VERSION}</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.5</string></dict></plist>\n`);
  run('/usr/bin/codesign',['--force','--sign','-',join(bundle,'LineBridge.app')],{stdio:'pipe'});
  run('/usr/bin/codesign',['--verify','--strict',join(bundle,'LineBridge.app')],{stdio:'pipe'});
  return 'LineBridge.app';
}
