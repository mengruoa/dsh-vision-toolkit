/**
 * Minimal S3-compatible object storage bridge used by the URL image-transfer
 * path. It uploads one image, resolves a model-reachable URL (a configured
 * public base URL or a temporary presigned URL), and deletes the object after
 * the vision operation settles. It also provides the Settings "test storage"
 * probe (upload → head → delete).
 * @module dsh-vision-toolkit/object-storage
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { VisionToolkitError } from "./errors.js";
/** Whether the required connection fields are present enough to attempt a request. */
export function isObjectStorageConfigured(settings) {
    return settings.endpoint.length > 0
        && settings.bucket.length > 0
        && settings.accessKeyId.length > 0
        && settings.secretAccessKey.length > 0;
}
/** Stable object-key prefix so every upload lives under one deletable namespace. */
const OBJECT_KEY_PREFIX = 'dsh-vision-toolkit';
function encodeKey(key) {
    return key.split('/').map(encodeURIComponent).join('/');
}
function clientFor(settings) {
    const config = {
        region: 'auto',
        forcePathStyle: true,
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
    };
    if (settings.endpoint.length > 0)
        config.endpoint = settings.endpoint;
    return new S3Client(config);
}
function publicError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** A small S3-compatible object store bound to one bucket and credential. */
export class ObjectStorageClient {
    settings;
    client;
    constructor(settings) {
        this.settings = settings;
    }
    requireClient() {
        if (this.client === undefined)
            this.client = clientFor(this.settings);
        return this.client;
    }
    /** Upload one local image file and resolve its model-reachable URL. */
    async uploadImage(localPath, contentType) {
        const body = await readFile(localPath);
        const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
        const name = basename(localPath).replace(/[^A-Za-z0-9._-]/g, '_');
        const key = `${OBJECT_KEY_PREFIX}/${randomUUID()}-${digest}-${name}`;
        try {
            await this.requireClient().send(new PutObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
                Body: body,
                ContentType: contentType,
            }));
        }
        catch (error) {
            throw new VisionToolkitError('service', `object storage upload failed: ${publicError(error)}`, { cause: error });
        }
        return { key, url: await this.urlFor(key) };
    }
    /** Resolve the model-reachable URL: public base URL when set, else presigned. */
    async urlFor(key) {
        if (this.settings.publicBase !== undefined && this.settings.publicBase.length > 0) {
            return `${this.settings.publicBase}/${encodeKey(key)}`;
        }
        try {
            return await getSignedUrl(this.requireClient(), new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }), { expiresIn: 3600 });
        }
        catch (error) {
            throw new VisionToolkitError('service', `object storage presign failed: ${publicError(error)}`, { cause: error });
        }
    }
    /** Delete one uploaded object; failures are logged, never fatal to the call. */
    async deleteObject(key) {
        try {
            await this.requireClient().send(new DeleteObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
            }));
        }
        catch {
            // Best-effort cleanup: a failed delete must not mask the vision result.
        }
    }
    /** Settings "test storage" probe: upload a tiny object, head it, then delete it. */
    async test() {
        if (!isObjectStorageConfigured(this.settings)) {
            throw new VisionToolkitError('config', 'object storage is not fully configured (endpoint, bucket, access key id, and secret access key are required)');
        }
        const key = `${OBJECT_KEY_PREFIX}/.connection-test-${randomUUID()}`;
        const marker = `dsh-vision-toolkit object storage test ${Date.now()}`;
        try {
            await this.requireClient().send(new PutObjectCommand({
                Bucket: this.settings.bucket,
                Key: key,
                Body: marker,
                ContentType: 'text/plain',
            }));
            await this.requireClient().send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }));
            await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }));
        }
        catch (error) {
            throw new VisionToolkitError('service', `object storage test failed: ${publicError(error)}`, { cause: error });
        }
        const urlMode = this.settings.publicBase !== undefined && this.settings.publicBase.length > 0
            ? `public base ${this.settings.publicBase}`
            : 'presigned URL';
        return { detail: `bucket ${this.settings.bucket} reachable; model URLs will use ${urlMode}` };
    }
}
/**
 * Split a credential value of the form `accessKeyId:secretAccessKey` into its
 * two parts. The access key id never contains a colon, so splitting on the
 * first colon is safe.
 */
export function splitObjectStorageCredential(value) {
    const index = value.indexOf(':');
    if (index <= 0) {
        throw new VisionToolkitError('config', 'object storage credential must be "accessKeyId:secretAccessKey"');
    }
    return {
        accessKeyId: value.slice(0, index),
        secretAccessKey: value.slice(index + 1),
    };
}
//# sourceMappingURL=object-storage.js.map