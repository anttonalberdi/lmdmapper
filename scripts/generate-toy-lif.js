const fs = require('fs');
const path = require('path');

const width = 64;
const height = 64;
const channels = 3;
const size = width * height * channels;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LMSDataContainerHeader>
  <Element Name="Toy RGB Element">
    <Memory Size="${size}" MemoryBlockID="MemBlock_1" />
    <Dimensions>
      <DimensionDescription DimID="X" NumberOfElements="${width}" Resolution="8" />
      <DimensionDescription DimID="Y" NumberOfElements="${height}" Resolution="8" />
      <DimensionDescription DimID="C" NumberOfElements="${channels}" Resolution="8" />
    </Dimensions>
    <Channels>
      <ChannelDescription Resolution="8" />
      <ChannelDescription Resolution="8" />
      <ChannelDescription Resolution="8" />
    </Channels>
    <StageposX>100.0</StageposX>
    <StageposY>50.0</StageposY>
    <ExperimentInfo DateAndTime="2026-02-06T12:00:00" />
    <LaserLineSetting Wavelength="488" Power="25" />
  </Element>
</LMSDataContainerHeader>`;

const header = Buffer.from(xml, 'utf8');
const memBlockId = 'MemBlock_1';
const token = Buffer.from(memBlockId, 'ascii');
const sizeBuf = Buffer.alloc(8);
sizeBuf.writeBigUInt64LE(BigInt(size), 0);

const pixels = Buffer.alloc(size);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 3;
    pixels[index] = Math.round((x / (width - 1)) * 255);
    pixels[index + 1] = Math.round((y / (height - 1)) * 255);
    pixels[index + 2] = 180;
  }
}

const output = Buffer.concat([header, token, sizeBuf, pixels]);
const outPath = path.join(process.cwd(), 'toy.lif');
fs.writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${output.length} bytes)`);
