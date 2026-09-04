/**
 * Minimal S3-compatible object storage bridge used by the URL image-transfer
 * path. It uploads one image, resolves a model-reachable URL (a configured
 * public base URL or a temporary presigned URL), and deletes the object after
 * the vision operation settles. It also provides the Settings "test storage"
 * probe (upload → head → delete).
 * @module dsh-vision-toolkit/object-storage
 */
/** Fully resolved object-storage connection settings (secrets already filled). */
export interface ObjectStorageSettings {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBase?: string;
}
/** Whether the required connection fields are present enough to attempt a request. */
export declare function isObjectStorageConfigured(settings: ObjectStorageSettings): boolean;
/**
 * One upload's worth of bookkeeping: the object key and the URL handed to the
 * model. The key is returned to the runtime so it can delete the object after
 * the operation settles.
 */
export interface UploadedObject {
    key: string;
    url: string;
}
/** A small S3-compatible object store bound to one bucket and credential. */
export declare class ObjectStorageClient {
    private readonly settings;
    private client?;
    constructor(settings: ObjectStorageSettings);
    private requireClient;
    /** Upload one local image file and resolve its model-reachable URL. */
    uploadImage(localPath: string, contentType: string): Promise<UploadedObject>;
    /** Resolve the model-reachable URL: public base URL when set, else presigned. */
    urlFor(key: string): Promise<string>;
    /** Delete one uploaded object; failures are logged, never fatal to the call. */
    deleteObject(key: string): Promise<void>;
    /** Settings "test storage" probe: upload a tiny object, head it, then delete it. */
    test(): Promise<{
        detail: string;
    }>;
}
/**
 * Split a credential value of the form `accessKeyId:secretAccessKey` into its
 * two parts. The access key id never contains a colon, so splitting on the
 * first colon is safe.
 */
export declare function splitObjectStorageCredential(value: string): {
    accessKeyId: string;
    secretAccessKey: string;
};
//# sourceMappingURL=object-storage.d.ts.map