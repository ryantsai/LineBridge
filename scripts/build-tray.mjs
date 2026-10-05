import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {root} from './packaging.mjs';
import {VERSION} from '../server/version.mjs';

export async function buildTray(bundle,platform=process.platform){
  if(platform!==process.platform)throw new Error('Build the tray on its target OS.');
  if(platform==='win32'){
    const compiler=join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',`/win32icon:${join(root,'tray/icon.ico')}`,`/out:${join(bundle,'LineBridge.exe')}`,join(root,'tray/windows.cs')],{stdio:'pipe',windowsHide:true});
    return 'LineBridge.exe';
  }
  if(platform!=='darwin')throw new Error('Tray supported on Windows and macOS only.');
  const contents=join(bundle,'LineBridge.app/Contents'),binary=join(contents,'MacOS/LineBridge');
  await mkdir(join(contents,'MacOS'),{recursive:true});
  await mkdir(join(contents,'Resources'),{recursive:true});
  await copyFile(join(root,'tray/icon.icns'),join(contents,'Resources/icon.icns'));
  execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.5`,'-O','-framework','AppKit','-o',binary,join(root,'tray/macos.swift')],{stdio:'pipe'});
  await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LineBridge</string><key>CFBundleIdentifier</key><string>com.ryantsai.linebridge.tray</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleName</key><string>LineBridge</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${VERSION}</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.5</string></dict></plist>\n`);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',join(bundle,'LineBridge.app')],{stdio:'pipe'});
  return 'LineBridge.app';
}
