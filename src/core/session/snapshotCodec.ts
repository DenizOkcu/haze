import type {ModelMessage} from 'ai';

const FILE_DATA_TAG = '__haze_file_data_v1';

/** Convert binary and URL file data into an unambiguous JSON representation. */
export function encodeSnapshotMessages(messages: ModelMessage[]): ModelMessage[] {
  return mapFileData(messages, data => {
    if (data instanceof Uint8Array) return {[FILE_DATA_TAG]: 'bytes', value: Buffer.from(data).toString('base64')};
    if (data instanceof ArrayBuffer) return {[FILE_DATA_TAG]: 'array-buffer', value: Buffer.from(data).toString('base64')};
    if (data instanceof URL) return {[FILE_DATA_TAG]: 'url', value: data.href};
    return data;
  });
}

/** Reconstruct file data before passing restored messages back to the SDK. */
export function decodeSnapshotMessages(messages: ModelMessage[]): ModelMessage[] {
  return mapFileData(messages, data => {
    if (typeof data !== 'object' || data === null || !(FILE_DATA_TAG in data)) return data;
    const marker = data as Record<string, unknown>;
    if (typeof marker.value !== 'string') throw new Error('invalid snapshot file data');
    if (marker[FILE_DATA_TAG] === 'url') return new URL(marker.value);
    if ((marker[FILE_DATA_TAG] !== 'bytes' && marker[FILE_DATA_TAG] !== 'array-buffer') || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(marker.value)) throw new Error('invalid snapshot file data');
    const bytes = Uint8Array.from(Buffer.from(marker.value, 'base64'));
    return marker[FILE_DATA_TAG] === 'array-buffer' ? bytes.buffer : bytes;
  });
}

function mapFileData(messages: ModelMessage[], map: (data: unknown) => unknown): ModelMessage[] {
  const mapValue = (value: unknown): unknown => {
    const mapped = map(value);
    if (mapped !== value || typeof value !== 'object' || value === null) return mapped;
    const record = value as Record<string, unknown>;
    if (record.type === 'data' && 'data' in record) return {...record, data: map(record.data)};
    if (record.type === 'url' && 'url' in record) return {...record, url: map(record.url)};
    return value;
  };
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    return {...message, content: message.content.map(part => part.type === 'file' ? {...part, data: mapValue(part.data)} : part.type === 'image' ? {...part, image: mapValue(part.image)} : part)} as ModelMessage;
  });
}
