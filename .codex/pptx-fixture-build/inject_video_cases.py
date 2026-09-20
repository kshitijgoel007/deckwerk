#!/usr/bin/env python3
"""Turn tagged poster pictures on CORE-15 into embedded, trimmed video shapes."""
from __future__ import annotations
import shutil, sys, tempfile, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P="http://schemas.openxmlformats.org/presentationml/2006/main"; A="http://schemas.openxmlformats.org/drawingml/2006/main"
R="http://schemas.openxmlformats.org/officeDocument/2006/relationships"; PR="http://schemas.openxmlformats.org/package/2006/relationships"
P14="http://schemas.microsoft.com/office/powerpoint/2010/main"; CT="http://schemas.openxmlformats.org/package/2006/content-types"
for prefix, uri in {"p":P,"a":A,"r":R,"p14":P14}.items(): ET.register_namespace(prefix, uri)
def q(ns, name): return f"{{{ns}}}{name}"

def main(pptx_path, video_path):
    pptx=Path(pptx_path)
    with tempfile.TemporaryDirectory() as raw:
        root=Path(raw)
        with zipfile.ZipFile(pptx) as z: z.extractall(root)
        slide_path=root/"ppt/slides/slide15.xml"; rels_path=root/"ppt/slides/_rels/slide15.xml.rels"
        slide=ET.parse(slide_path); rels=ET.parse(rels_path); rel_root=rels.getroot()
        used={n.get("Id") for n in rel_root}
        def rid():
            i=1
            while f"rId{i}" in used: i+=1
            value=f"rId{i}"; used.add(value); return value
        video_rid, media_rid=rid(), rid()
        for rel_id, rel_type in [(video_rid,"http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"),(media_rid,"http://schemas.microsoft.com/office/2007/relationships/media")]:
            ET.SubElement(rel_root,q(PR,"Relationship"),{"Id":rel_id,"Type":rel_type,"Target":"../media/video-calibration.mp4"})
        cases=[(1250,750,False,False,None),(500,500,False,False,None),(250,250,False,False,45000),(1000,1000,True,True,None)]
        pictures=slide.getroot().findall(f".//{q(P,'pic')}")
        if len(pictures) != len(cases): raise RuntimeError(f"Expected 4 video poster pictures on slide 15, found {len(pictures)}")
        for pic, (start,end,flip_h,flip_v,alpha) in zip(pictures,cases):
            nvpr=pic.find(f"./{q(P,'nvPicPr')}/{q(P,'nvPr')}")
            ET.SubElement(nvpr,q(A,"videoFile"),{q(R,"link"):video_rid})
            ext=ET.SubElement(ET.SubElement(nvpr,q(P,"extLst")),q(P,"ext"),{"uri":"{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"})
            media=ET.SubElement(ext,q(P14,"media"),{q(R,"embed"):media_rid}); ET.SubElement(media,q(P14,"trim"),{"st":str(start),"end":str(end)})
            xfrm=pic.find(f"./{q(P,'spPr')}/{q(A,'xfrm')}")
            if flip_h: xfrm.set("flipH","1")
            if flip_v: xfrm.set("flipV","1")
            if alpha is not None: ET.SubElement(pic.find(f"./{q(P,'blipFill')}/{q(A,'blip')}"),q(A,"alphaModFix"),{"amt":str(alpha)})
        (root/"ppt/media").mkdir(parents=True,exist_ok=True); shutil.copyfile(video_path,root/"ppt/media/video-calibration.mp4")
        ct_path=root/"[Content_Types].xml"; ct=ET.parse(ct_path)
        if not any(n.get("Extension")=="mp4" for n in ct.getroot()): ET.SubElement(ct.getroot(),q(CT,"Default"),{"Extension":"mp4","ContentType":"video/mp4"})
        slide.write(slide_path,encoding="utf-8",xml_declaration=True); rels.write(rels_path,encoding="utf-8",xml_declaration=True)
        ET.register_namespace("",CT); ct.write(ct_path,encoding="utf-8",xml_declaration=True)
        replacement=pptx.with_suffix(".video-injected.pptx")
        with zipfile.ZipFile(replacement,"w",zipfile.ZIP_DEFLATED) as z:
            for item in sorted(root.rglob("*")):
                if item.is_file(): z.write(item,item.relative_to(root).as_posix())
        replacement.replace(pptx)
if __name__=="__main__": main(sys.argv[1],sys.argv[2])
