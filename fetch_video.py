import json
import os
import time

import requests
import os
import time
from tqdm import tqdm  # 需要安装: pip install tqdm


def download_file_enhanced(
        url,
        save_path=None,
        max_retries=3,
        timeout=30,
        headers=None
):
    """
    增强版文件下载，支持重试和进度条
    """
    # 默认请求头
    if headers is None:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }

    # 生成保存路径
    if save_path is None:
        filename = url.split('/')[-1].split('?')[0]
        if not filename:
            filename = f"file_{int(time.time())}"
        save_path = filename

    # 确保目录存在
    os.makedirs(os.path.dirname(save_path), exist_ok=True)

    for attempt in range(max_retries):
        try:
            print(f"尝试 {attempt + 1}/{max_retries}: 下载 {url}")

            # 发送HEAD请求获取文件信息
            head_response = requests.head(url, headers=headers, timeout=timeout)
            total_size = int(head_response.headers.get('content-length', 0))

            # 断点续传检查
            start_byte = 0
            if os.path.exists(save_path):
                start_byte = os.path.getsize(save_path)
                if start_byte == total_size:
                    print(f"文件已存在且完整: {save_path}")
                    return save_path

            # 设置断点续传头部
            headers_range = headers.copy()
            if start_byte > 0:
                headers_range['Range'] = f'bytes={start_byte}-'

            # 下载文件
            response = requests.get(url, headers=headers_range, stream=True, timeout=timeout)
            response.raise_for_status()

            # 获取实际要下载的大小
            if start_byte > 0:
                total_size = int(response.headers.get('content-length', 0)) + start_byte

            # 以追加模式打开文件
            mode = 'ab' if start_byte > 0 else 'wb'
            with open(save_path, mode) as f:
                with tqdm(
                        total=total_size,
                        initial=start_byte,
                        unit='B',
                        unit_scale=True,
                        unit_divisor=1024,
                        desc=os.path.basename(save_path)
                ) as pbar:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            pbar.update(len(chunk))

            print(f"下载完成: {save_path}")
            return save_path

        except requests.exceptions.RequestException as e:
            print(f"尝试 {attempt + 1} 失败: {e}")
            if attempt < max_retries - 1:
                print(f"等待 {2 ** attempt} 秒后重试...")
                time.sleep(2 ** attempt)
            else:
                print(f"达到最大重试次数，下载失败")
                return None

def walk_through_dir(wrkPath):
    src_wrk_path  = os.path.join(wrkPath, 'srcwrk')
    json_list_src = os.listdir(src_wrk_path)
    json_list = [ os.path.join(wrkPath, 'srcwrk', json_item) for json_item in json_list_src if json_item.endswith(".json") ]
    return json_list

def read_json(json_file, wrkPath):
    save_wrk_path = os.path.join(wrkPath, 'savewrk')
    with open(json_file) as json_file:
        seed_list = json.load(json_file)
    # print(type(seed_list.get('data')[0]))
    print(seed_list.get('data')[0].keys())
    # print(seed_list.get('data')[0].get('response').get('feeds')[0].keys())
    # print(seed_list.get('data')[0].get('response').get('feeds')[0])

    feeds = seed_list.get('data')[0].get('response').get('feeds')
    for feed_item in feeds:
        key_str = ''
        # print(type(feed_item))
        # print(feed_item.keys())
        # print(feed_item.keys())
        tag_list = feed_item.get('tags')
        # print(feed_item)
        print('tag___', "--"*10)
        print(tag_list)
        if tag_list:
            for tag_item in tag_list:
                key_str = key_str + "_" + tag_item.get('name')

        photo_item = feed_item.get('photo')
        video_item = photo_item.get('photoUrls')[0]
        video_url = video_item.get('url')
        animate_cover = photo_item.get('animatedCoverUrl')
        cover_item = photo_item.get('coverUrl')
        caption = photo_item.get('caption')
        timestamp = photo_item.get('timestamp')

        date_str = time.strftime('%Y-%m-%d_%H-%M', time.localtime(timestamp / 1000))

        save_dir = "{}_{}".format(date_str, caption)
        save_path = os.path.join(save_wrk_path, save_dir)
        video_file = os.path.join(save_path, "{}.mp4".format(caption))
        webp_file = os.path.join(save_path, "{}.webp".format(caption))
        jpg_file = os.path.join(save_path, "{}.jpg".format(caption))
        text_file = os.path.join(save_path, "{}.txt".format(caption))

        if not os.path.exists(save_path):
            os.makedirs(save_path)

        download_file_enhanced(video_url, video_file, max_retries=2)
        download_file_enhanced(animate_cover, webp_file, max_retries=2)
        download_file_enhanced(cover_item, jpg_file, max_retries=2)
        with open(text_file, 'w') as f:
            f.write("caption: {} \n tag: {}".format(caption, key_str))




if __name__ == '__main__':
    wrk_path = "/videowrk/kuaishouwrk/"
    ks_list = walk_through_dir(wrk_path)
    for ks_item in ks_list:
        read_json(ks_item, wrk_path)
