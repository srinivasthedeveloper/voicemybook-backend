const multer = require('multer');

function errorHandler(err, req, res, next) {
  console.error('[Error]', err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds size limit` });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.message === 'Only PDF files are accepted') {
    return res.status(400).json({ error: err.message });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
}

module.exports = errorHandler;
