import { FileViewer } from './file-viewer.js';

export class PDFViewer extends FileViewer {
  constructor(workspace, options = {}) { super(workspace, { ...options, allowedExtensions: new Set(['.pdf']) }); }
}
