// Spike 3, PC side: advertise a neutral name and browse for it from this same
// process, so it shows the library works on this machine's adapters. It says
// nothing about whether a phone can see it; that needs a real device, because
// the Android emulator has no multicast.
import { Bonjour } from 'bonjour-service';
import os from 'node:os';

const seconds = Number(process.argv[2] ?? 15);
const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
  (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => `${name}=${i.address}`));
console.log('adapters', interfaces.join(', '));

const bonjour = new Bonjour();
bonjour.publish({ name: 'sertum-spike', type: 'sertum-spike', port: 8843, txt: { v: '0' } });
const browser = bonjour.find({ type: 'sertum-spike' }, (service) => {
  console.log('found', JSON.stringify({ name: service.name, port: service.port, addresses: service.addresses }));
});
const started = Date.now();
browser.on('up', () => console.log('up after ms', Date.now() - started));

setTimeout(() => {
  browser.stop();
  bonjour.unpublishAll(() => bonjour.destroy(() => {
    console.log('done');
    process.exit(0);
  }));
}, seconds * 1000);
