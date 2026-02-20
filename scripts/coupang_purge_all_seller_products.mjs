// Purge (delete) all seller products that are deletable via seller_api.
// NOTE: Coupang seller_api allows DELETE only for certain statuses (e.g., 저장중/임시저장).
// For 승인완료/승인반려 etc, DELETE may be refused.
//
// Usage:
//   node scripts/coupang_purge_all_seller_products.mjs --email=eue5003@naver.com --dryRun=1
//   node scripts/coupang_purge_all_seller_products.mjs --email=eue5003@naver.com
//
// Output:
// - Writes data/purge_report.json (not committed)
// - Prints a concise summary.

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';

import { listSellerProducts } from '../src/coupang/api/listSellerProducts.js';
import { deleteSellerProduct } from '../src/coupang/api/deleteSellerProduct.js';

function parseArgs(argv){
  const out={ email:'', dryRun:false, limit:0 };
  for(const a of argv.slice(2)){
    if(a.startsWith('--email=')) out.email=a.split('=')[1]||'';
    if(a.startsWith('--dryRun=')) out.dryRun=(a.split('=')[1]||'')==='1';
    if(a.startsWith('--limit=')) out.limit=Number(a.split('=')[1]||0)||0;
  }
  return out;
}

const { email, dryRun, limit } = parseArgs(process.argv);
if(!email){
  console.error('missing --email');
  process.exit(2);
}

const DB_PATH = path.join(process.cwd(),'data','app.db');
const db=new sqlite3.Database(DB_PATH);
const dbGet=(sql,p=[])=>new Promise((res,rej)=>db.get(sql,p,(e,row)=>e?rej(e):res(row)));

const user=await dbGet('select id, settings_json from users where email=?',[email]);
if(!user){
  console.error('user not found');
  process.exit(2);
}

const settings=JSON.parse(user.settings_json||'{}');
const vendorId=String(settings.coupangVendorId||'').trim();
const accessKey=String(settings.coupangAccessKey||'').trim();
const secretKey=String(settings.coupangSecretKey||'').trim();
if(!vendorId||!accessKey||!secretKey){
  console.error('missing coupang keys/vendorId in settings');
  process.exit(2);
}

db.close();

const report={
  at: new Date().toISOString(),
  vendorId,
  dryRun,
  totalListed: 0,
  deleted: [],
  failed: [],
  remaining: [],
};

let nextToken=null;
let page=0;
while(true){
  page++;
  const res=await listSellerProducts({vendorId, nextToken, maxPerPage:50, accessKey, secretKey});
  if(res.status!==200){
    report.failed.push({step:'list', status:res.status, body:String(res.body).slice(0,500)});
    break;
  }
  const body=JSON.parse(res.body);
  const data=Array.isArray(body.data)? body.data: [];
  nextToken=body.nextToken||null;

  for(const it of data){
    report.totalListed++;
    if(limit && report.totalListed>limit) break;

    const sellerProductId=it.sellerProductId;
    const statusName=it.statusName;
    const name=it.sellerProductName;
    if(dryRun){
      report.remaining.push({sellerProductId, statusName, name});
      continue;
    }

    const del=await deleteSellerProduct({sellerProductId, accessKey, secretKey});
    const delBody=String(del.body||'');
    if(del.status===200){
      report.deleted.push({sellerProductId, statusName, name});
    } else {
      report.failed.push({sellerProductId, statusName, name, status:del.status, message:delBody.slice(0,240)});
      report.remaining.push({sellerProductId, statusName, name});
    }

    // pacing
    await new Promise(r=>setTimeout(r, 180));
  }

  if(limit && report.totalListed>=limit) break;
  if(!nextToken) break;
  // small delay between pages
  await new Promise(r=>setTimeout(r, 220));
}

// Write report
try{
  const outPath=path.join(process.cwd(),'data','purge_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report,null,2));
}catch{}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  vendorId,
  totalListed: report.totalListed,
  deleted: report.deleted.length,
  failed: report.failed.length,
  remaining: report.remaining.length,
}, null, 2));
