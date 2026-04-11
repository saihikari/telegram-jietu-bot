const ExcelJS = require('exceljs');
const fs = require('fs');

async function test() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Test');

  // Create a dummy image
  const imgBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  
  const imgId = workbook.addImage({
    buffer: imgBuffer,
    extension: 'png'
  });

  sheet.addImage(imgId, {
    tl: { col: 0, row: 0 },
    ext: { width: 100.5, height: 100.5 } // Using floats to test
  });

  sheet.addImage(imgId, {
    tl: { col: 2, row: 0 },
    ext: { width: 100, height: 100 } // Using ints
  });

  await workbook.xlsx.writeFile('test-float.xlsx');
  console.log('Saved test-float.xlsx');
}

test().catch(console.error);
