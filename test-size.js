const sizeOf = require('image-size');
try {
  const dimensions = sizeOf('temp/report_1775843058601.xlsx'); // Just testing if the module works
  console.log(dimensions);
} catch(e) {
  console.log(e.message);
}
