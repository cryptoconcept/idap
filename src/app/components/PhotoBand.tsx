import React from 'react';
import AppImage from '@/components/ui/AppImage';

const rowOne = [
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_183b5bc77-1768108455008.png",
  alt: 'Students in a bright classroom with natural light, teacher at the front, modern school interior'
},
{
  src: "https://images.unsplash.com/photo-1709290749293-c6152a187b14",
  alt: 'Teacher explaining a lesson to attentive students in a warm-lit Indian school classroom'
},
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_188ab462b-1784734743020.png",
  alt: 'Students browsing books in a school library with wooden shelves and warm reading lights'
},
{
  src: "https://images.unsplash.com/photo-1675410163638-f6a348ebc500",
  alt: 'Graduation ceremony with students in academic robes celebrating outdoors on a sunny day'
},
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_1e2e9c2ec-1770491300688.png",
  alt: 'Teacher and students working together at a table in a bright collaborative classroom space'
},
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_11c47f106-1772731682322.png",
  alt: 'Students raising hands enthusiastically in a school classroom with colourful displays on walls'
}];


const rowTwo = [
{
  src: "https://images.unsplash.com/photo-1544531586-72498410ecec",
  alt: 'Young students seated in rows in a school hall for a morning assembly, bright overhead lights'
},
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_1f36682fd-1783548137666.png",
  alt: 'Students working on laptops in a school computer lab, focused on their screens'
},
{
  src: "https://images.unsplash.com/photo-1727020809995-26567ed99e63",
  alt: 'School corridor with students walking between classes, bright tiled floors and notice boards'
},
{
  src: "https://img.rocket.new/generatedImages/rocket_gen_img_12a361827-1767794495080.png",
  alt: 'Students in science lab performing experiments, wearing safety goggles under fluorescent lights'
},
{
  src: "https://images.unsplash.com/photo-1733824204474-e1b329a33612",
  alt: 'Teacher at whiteboard explaining mathematics to students in a well-lit secondary school room'
},
{
  src: "https://images.unsplash.com/photo-1714263005503-2792c0eeab24",
  alt: 'School sports day with students running on a track, spectators cheering on a sunny afternoon'
}];


function MarqueeRow({
  images,
  direction



}: {images: typeof rowOne;direction: 'left' | 'right';}) {
  const doubled = [...images, ...images];
  return (
    <div className="marquee-track overflow-hidden">
      <div
        className={`flex gap-4 w-max ${
        direction === 'left' ? 'animate-marquee-left' : 'animate-marquee-right'}`
        }>
        
        {doubled.map((img, i) =>
        <div
          key={i}
          className={`flex-shrink-0 w-64 md:w-72 h-44 rounded-xl overflow-hidden border-2 border-white shadow-lg ${
          i % 3 === 0 ? 'photo-card-tilt-left' : i % 3 === 1 ? '' : 'photo-card-tilt-right'}`
          }>
          
            <AppImage
            src={img.src}
            alt={img.alt}
            width={288}
            height={176}
            className="object-cover w-full h-full hover:scale-105 transition-transform duration-500" />
          
          </div>
        )}
      </div>
    </div>);

}

export default function PhotoBand() {
  return (
    <section className="py-16 md:py-20 bg-secondary/20 border-t border-border overflow-hidden">
      <div className="container max-w-5xl mx-auto px-6 mb-10 text-center">
        <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
          Schools across India
        </p>
        <h2 className="font-display text-2xl md:text-3xl font-bold text-primary">
          Built for the institutions that shape futures<span className="text-marigold">.</span>
        </h2>
      </div>

      <div className="flex flex-col gap-5">
        <MarqueeRow images={rowOne} direction="left" />
        <MarqueeRow images={rowTwo} direction="right" />
      </div>
    </section>);

}