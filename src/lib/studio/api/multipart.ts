import { PayloadTooLargeError, ValidationError } from '../../errors';

// Multipart uploads (voice samples, logos): the declared size is checked before anything is
// buffered, then the body is parsed with the platform's FormData parser.

export async function readMultipart(req: Request, maxBytes: number): Promise<FormData> {
  const length = Number(req.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0)
    throw new ValidationError('Content-Length is required for uploads');
  if (length > maxBytes)
    throw new PayloadTooLargeError(
      `Upload is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`,
    );
  if (!req.headers.get('content-type')?.startsWith('multipart/form-data'))
    throw new ValidationError('Upload must be multipart/form-data');
  try {
    return await req.formData();
  } catch {
    throw new ValidationError('Malformed multipart body');
  }
}

/** A File field, or undefined. Strings (e.g. a filename typed into a text field) are refused. */
export function fileField(form: FormData, name: string): File | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (typeof value === 'string') throw new ValidationError(`${name} must be a file`);
  return value;
}

export function fileFields(form: FormData, name: string): File[] {
  return form.getAll(name).map((value) => {
    if (typeof value === 'string') throw new ValidationError(`${name} must be files`);
    return value;
  });
}

export function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  return value;
}
