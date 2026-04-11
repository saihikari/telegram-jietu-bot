const ExcelJS = require('exceljs');
const fs = require('fs');
const { imageSize } = require('image-size');

async function test() {
  const workbook = new ExcelJS.Workbook();
  const detailSheet = workbook.addWorksheet('Test');
  
  // Download a real sample image to test
  const nodeFetch = require('node-fetch');
  const res = await nodeFetch('https://picsum.photos/400/800');
  const buffer = await res.buffer();
  fs.writeFileSync('sample.jpg', buffer);

  let currentRow = 1;
  const dimensions = imageSize('sample.jpg');
  
  const maxWidthPx = 840;
  let finalWidthPx = dimensions.width;
  let finalHeightPx = dimensions.height;

  if (finalWidthPx > maxWidthPx) {
    const ratio = maxWidthPx / finalWidthPx;
    finalWidthPx = maxWidthPx;
    finalHeightPx = finalHeightPx * ratio;
  }

  const imgWidth = Math.round(finalWidthPx);
  const imgHeight = Math.round(finalHeightPx);

  const imageId = workbook.addImage({
    buffer: fs.readFileSync('sample.jpg'),
    extension: 'jpeg'
  });

  const spannedRows = Math.ceil(imgHeight / 20) + 1;

  detailSheet.addImage(imageId, {
    tl: { col: 0, row: currentRow - 1 },
    br: { col: 10, row: currentRow - 1 + spannedRows - 1 },
    editAs: 'oneCell'
  });
  
  // Also try ext approach just to see
  detailSheet.addImage(imageId, {
    tl: { col: 12, row: currentRow - 1 },
    ext: { width: imgWidth, height: imgHeight },
    editAs: 'oneCell'
  });

  await workbook.xlsx.writeFile('test-images4.xlsx');
  console.log('Saved test-images4.xlsx');
}

test().catch(console.error);
