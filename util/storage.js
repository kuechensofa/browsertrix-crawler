import fs from "fs";
import fsp from "fs/promises";

import os from "os";
import { createHash } from "crypto";

import Minio from "minio";

import { initRedis } from "./redis.js";

import getFolderSize from "get-folder-size";


// ===========================================================================
export class S3StorageSync
{
  constructor(urlOrData, {webhookUrl, userId, crawlId} = {}) {
    let url;
    let accessKey;
    let secretKey;

    if (typeof(urlOrData) === "string") {
      url = new URL(urlOrData);
      accessKey = url.username;
      secretKey = url.password;
      url.username = "";
      url.password = "";
      this.fullPrefix = url.href;

    } else {
      url = new URL(urlOrData.endpointUrl);
      accessKey = urlOrData.accessKey;
      secretKey = urlOrData.secretKey;
      this.fullPrefix = url.href;
    }

    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
      partSize: 100*1024*1024
    });

    this.client.enableSHA256 = true;

    this.bucketName = url.pathname.slice(1).split("/")[0];

    this.objectPrefix = url.pathname.slice(this.bucketName.length + 2);

    this.resources = [];

    this.userId = userId;
    this.crawlId = crawlId;
    this.webhookUrl = webhookUrl;
  }

  async uploadFile(srcFilename, targetFilename) {
    console.log(`Bucket: ${this.bucketName}`);
    console.log(`Crawl Id: ${this.crawlId}`);
    console.log(`Prefix: ${this.objectPrefix}`);
    console.log(`Target Filename: ${targetFilename}`);

    await this.client.fPutObject(this.bucketName, this.objectPrefix + targetFilename, srcFilename);

    const finalHash = await checksumFile("sha256", srcFilename);

    const size = await getFileSize(srcFilename);
    return {"path": targetFilename, "hash": finalHash, "bytes": size};
  }

  async downloadFile(srcFilename, destFilename) {
    await this.client.fGetObject(this.bucketName, this.objectPrefix + srcFilename, destFilename);
  }

  async uploadCollWACZ(srcFilename, targetFilename, completed = true) {
    const resource = await this.uploadFile(srcFilename, targetFilename);
    console.log(resource);

    if (this.webhookUrl) {
      const body = {
        id: this.crawlId,
        user: this.userId,

        //filename: `s3://${this.bucketName}/${this.objectPrefix}${this.waczFilename}`,
        filename: this.fullPrefix + targetFilename,

        hash: resource.hash,
        size: resource.bytes,

        completed
      };

      console.log("Pinging Webhook: " + this.webhookUrl);

      if (this.webhookUrl.startsWith("http://") || this.webhookUrl.startsWith("https://")) {
        await fetch(this.webhookUrl, {method: "POST", body: JSON.stringify(body)});
      } else if (this.webhookUrl.startsWith("redis://")) {
        const parts = this.webhookUrl.split("/");
        if (parts.length !== 5) {
          throw new Error("redis webhook url must be in format: redis://<host>:<port>/<db>/<key>");
        }
        const redis = await initRedis(parts.slice(0, 4).join("/"));
        await redis.rpush(parts[4], JSON.stringify(body));
      }
    }
  }
}

export function initStorage() {
  if (!process.env.STORE_ENDPOINT_URL) {
    return null;
  }

  const endpointUrl = process.env.STORE_ENDPOINT_URL + (process.env.STORE_PATH || "");
  const storeInfo = {
    endpointUrl,
    accessKey: process.env.STORE_ACCESS_KEY,
    secretKey: process.env.STORE_SECRET_KEY,
  };

  const opts = {
    crawlId: process.env.CRAWL_ID || os.hostname(),
    webhookUrl: process.env.WEBHOOK_URL,
    userId: process.env.STORE_USER,
  };

  console.log("Initing Storage...");
  return new S3StorageSync(storeInfo, opts);
}


export async function getFileSize(filename) {
  const stats = await fsp.stat(filename);
  return stats.size;
}

export async function getDirSize(dir) {
  return await getFolderSize(dir);
}

function checksumFile(hashName, path) {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);
    const stream = fs.createReadStream(path);
    stream.on("error", err => reject(err));
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function interpolateFilename(filename, crawlId) {
  filename = filename.replace("@ts", new Date().toISOString().replace(/[:TZz.-]/g, ""));
  filename = filename.replace("@hostname", os.hostname());
  filename = filename.replace("@hostsuffix", os.hostname().slice(-14));
  filename = filename.replace("@id", crawlId);
  return filename;
}

