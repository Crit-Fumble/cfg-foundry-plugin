/**
 * Foundry v13 Compatible FilePicker Utility
 * Provides compatibility layer for FilePicker methods between Foundry v12 and v13+
 *
 * In Foundry v13, the global FilePicker is deprecated.
 * Use foundry.applications.api.FilePicker instead.
 */

/**
 * Get the appropriate FilePicker implementation
 * @returns {typeof FilePicker}
 */
function getFilePickerClass() {
  // Foundry v13+: foundry.applications.api.FilePicker
  if (typeof foundry !== 'undefined' && foundry.applications?.api?.FilePicker) {
    return foundry.applications.api.FilePicker
  }
  // Legacy: global FilePicker
  return FilePicker
}

/**
 * Browse a directory
 * @param {string} source - The source (e.g., 'data', 'public')
 * @param {string} target - The target path
 * @param {object} options - Additional options
 * @returns {Promise<object>} Browse result
 */
export async function fpBrowse(source, target, options = {}) {
  const FP = getFilePickerClass()
  return FP.browse(source, target, options)
}

/**
 * Create a directory
 * @param {string} source - The source (e.g., 'data')
 * @param {string} target - The target path
 * @param {object} options - Additional options
 * @returns {Promise<object>} Result
 */
export async function fpCreateDirectory(source, target, options = {}) {
  const FP = getFilePickerClass()
  return FP.createDirectory(source, target, options)
}

/**
 * Upload a file
 * @param {string} source - The source (e.g., 'data')
 * @param {string} path - The target path
 * @param {File} file - The file to upload
 * @param {object} body - Additional body data
 * @param {object} options - Additional options
 * @returns {Promise<object>} Upload result
 */
export async function fpUpload(source, path, file, body = {}, options = {}) {
  const FP = getFilePickerClass()
  return FP.upload(source, path, file, body, options)
}

/**
 * FilePicker compatibility object for drop-in replacement
 */
export const FilePickerCompat = {
  browse: fpBrowse,
  createDirectory: fpCreateDirectory,
  upload: fpUpload,

  /**
   * Get the actual FilePicker class (for instantiation or other static methods)
   * @returns {typeof FilePicker}
   */
  getClass: getFilePickerClass,
}

export default FilePickerCompat
