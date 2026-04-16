#!/usr/bin/env python3
"""
Turkish-AI: Bağımsız Türkçe Yapay Zeka — v3
Tüm geliştirmeler eklendi:

  • Validation split desteği (--val-split)
  • Beam search desteği (--beam-search)
  • Gradient checkpointing desteği (--gradient-checkpointing)
  • Örnek prompt desteği (--sample-prompt)
  • Veri limiti desteği (--max-samples)

Kullanım:
    python main.py --mode demo
    python main.py --mode interactive --model-size small
    python main.py --mode train --data ./datasets/wiki_clean.txt --epochs 3
    python main.py --mode chat --message "Merhaba" --checkpoint ./checkpoints/best_model.pt
"""

import argparse
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "src"))

from core.ai_engine      import TurkishAI, create_ai, train_new_ai
from data.data_collector import collect_turkish_data, DatasetManager


def train_mode(args):
    print("\n" + "=" * 60)
    print("🎓 EĞİTİM MODU")
    print("=" * 60)

    if args.collect_data:
        print("\n📚 Web'den veri toplanıyor...")
        conversations = collect_turkish_data(output_dir="./datasets")
    elif args.data:
        print(f"\n📂 Veri yükleniyor: {args.data}")
        manager = DatasetManager("./datasets")
        if args.data.endswith(".json"):
            conversations = manager.load_conversations(args.data)
            texts = None
        else:
            with open(args.data, "r", encoding="utf-8") as f:
                texts = f.read().split("\n\n---\n\n")
            texts = [t.strip() for t in texts if len(t.strip()) > 50]

            # Veri limiti
            if args.max_samples and args.max_samples > 0:
                texts = texts[:args.max_samples]
                print(f"   Veri limiti uygulandı: {len(texts)} paragraf")
            else:
                print(f"   Toplam paragraf: {len(texts)}")

            conversations = None
    else:
        print("❌ Hata: --data veya --collect-data gerekli")
        return

    print(f"\n🤖 AI oluşturuluyor (Boyut: {args.model_size})...")
    ai = TurkishAI(model_size=args.model_size)
    ai.initialize()

    if conversations:
        if args.train_tokenizer:
            texts = [c.get("input", "") + " " + c.get("output", "") for c in conversations]
            ai.train_tokenizer(texts)
        ai.train(
            conversations    = conversations,
            num_epochs       = args.epochs,
            batch_size       = args.batch_size,
            learning_rate    = args.lr,
            validation_split = args.val_split,
            sample_prompt    = args.sample_prompt
        )
    else:
        if args.train_tokenizer:
            ai.train_tokenizer(texts)
        ai.train(
            texts            = texts,
            num_epochs       = args.epochs,
            batch_size       = args.batch_size,
            learning_rate    = args.lr,
            validation_split = args.val_split,
            sample_prompt    = args.sample_prompt
        )

    ai.save_checkpoint("final_model.pt")
    print("\n✅ Eğitim tamamlandı ve kaydedildi!")


def chat_mode(args):
    print("\n" + "=" * 60)
    print("💬 TEK MESAJ MODU")
    print("=" * 60)

    ai = create_ai(model_size=args.model_size)

    if args.checkpoint:
        ai.load_checkpoint(args.checkpoint)

    response = ai.chat(
        args.message,
        max_length      = args.max_length,
        temperature     = args.temperature,
        use_beam_search = args.beam_search,
        num_beams       = args.num_beams
    )

    print(f"\nKullanıcı: {args.message}")
    print(f"AI: {response}")


def interactive_mode(args):
    print("\n" + "=" * 60)
    print("🚀 Turkish-AI İNTERAKTİF MOD")
    print("=" * 60)
    print("Komutlar:")
    print("  /reset   — Yeni konuşma başlat")
    print("  /save    — Checkpoint kaydet")
    print("  /stats   — İstatistikleri göster")
    print("  /learn   — Son yanıtı öğren (doğru ise)")
    print("  /forget  — Son yanıtı unut (yanlış ise)")
    print("  /beam    — Beam search aç/kapat")
    print("  /exit    — Çıkış")
    print("=" * 60 + "\n")

    ai = create_ai(model_size=args.model_size)

    if args.checkpoint:
        ai.load_checkpoint(args.checkpoint)

    use_beam = args.beam_search

    while True:
        try:
            user_input = input("\n👤 Siz: ").strip()
            if not user_input:
                continue

            if user_input.startswith("/"):
                if user_input == "/exit":
                    print("👋 Görüşmek üzere!")
                    break
                elif user_input == "/reset":
                    ai.reset_conversation()
                elif user_input == "/save":
                    ai.save_checkpoint()
                elif user_input == "/stats":
                    stats = ai.get_stats()
                    print("\n📊 İstatistikler:")
                    for k, v in stats.items():
                        print(f"   {k}: {v}")
                elif user_input == "/learn":
                    correct = input("Doğru yanıtı girin: ").strip()
                    if correct:
                        ai.learn_from_feedback(correct, positive=True)
                elif user_input == "/forget":
                    ai.learn_from_feedback("", positive=False)
                elif user_input == "/beam":
                    use_beam = not use_beam
                    print(f"Beam search: {'açık' if use_beam else 'kapalı'}")
                else:
                    print("❌ Bilinmeyen komut")
                continue

            print("\n🤖 AI düşünüyor...", end=" ", flush=True)
            response = ai.chat(
                user_input,
                max_length      = args.max_length,
                temperature     = args.temperature,
                use_memory      = True,
                use_beam_search = use_beam,
                num_beams       = args.num_beams
            )
            print("\r🤖 AI: " + response)

        except KeyboardInterrupt:
            print("\n\n👋 Görüşmek üzere!")
            break
        except RuntimeError as e:
            print(f"\n❌ {e}")
            print("   İpucu: Önce --mode train ile modeli eğitin.")
            break
        except Exception as e:
            print(f"\n❌ Hata: {e}")


def demo_mode(args):
    print("\n" + "=" * 60)
    print("🎮 DEMO MODU")
    print("=" * 60)

    sample_texts = [
        "Yapay zeka, insan zekasını taklit eden sistemlerdir. Makine öğrenimi ve derin öğrenme bu alanın temel dallarıdır.",
        "Makine öğrenimi, verilerden öğrenen algoritmaları içerir. Denetimli ve denetimsiz öğrenme başlıca yöntemlerdir.",
        "Derin öğrenme, yapay sinir ağları kullanır. Görüntü tanıma ve doğal dil işleme alanlarında çok başarılıdır.",
        "Türkiye, Avrupa ve Asya'nın kesişiminde yer alan köklü bir ülkedir. Tarihi ve kültürel zenginliğiyle öne çıkar.",
        "İstanbul, Türkiye'nin en büyük şehridir ve tarihî yarımada ile birçok tarihi eser barındırır.",
        "Mustafa Kemal Atatürk, Türkiye Cumhuriyeti'nin kurucusu ve ilk cumhurbaşkanıdır.",
        "Python, kolay söz dizimi ile öne çıkan ve veri biliminde yaygın kullanılan bir programlama dilidir.",
        "Doğal dil işleme, bilgisayarların insan dilini anlayıp üretmesini sağlayan yapay zeka dalıdır.",
        "Transformer mimarisi, modern büyük dil modellerinin temelini oluşturmaktadır.",
        "Tokenizer, metni alt parçalara ayıran ve modelin anlayabileceği sayılara çeviren bileşendir.",
    ]

    print("\n📚 BPE tokenizer eğitiliyor...")
    ai = TurkishAI(model_size="tiny")
    ai.initialize()
    ai.train_tokenizer(sample_texts)

    print("\n🎓 Model eğitiliyor (5 epoch)...")
    ai.train(
        texts            = sample_texts,
        num_epochs       = 5,
        batch_size       = 2,
        validation_split = 0.2,
        sample_prompt    = "Yapay zeka nedir?"
    )

    print("\n💬 Test konuşmaları:")
    for msg in ["Yapay zeka nedir?", "Türkiye hakkında bilgi ver", "Python nedir?"]:
        response = ai.chat(msg, max_length=60, use_memory=False)
        print(f"\n👤 {msg}")
        print(f"🤖 {response}")

    print("\n✅ Demo tamamlandı!")


def main():
    parser = argparse.ArgumentParser(
        description="Turkish-AI: Bağımsız Türkçe Yapay Zeka",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Örnekler:
  python main.py --mode demo
  python main.py --mode interactive --model-size small
  python main.py --mode train --data ./datasets/wiki_clean.txt --epochs 3 --max-samples 10000
  python main.py --mode chat --message "Merhaba" --checkpoint ./checkpoints/best_model.pt
        """
    )

    parser.add_argument("--mode", choices=["train", "chat", "interactive", "demo"], default="interactive")
    parser.add_argument("--model-size", choices=["tiny", "small", "medium", "large"], default="tiny")

    # Eğitim
    parser.add_argument("--data",                   type=str)
    parser.add_argument("--collect-data",            action="store_true")
    parser.add_argument("--train-tokenizer",         action="store_true")
    parser.add_argument("--epochs",                 type=int,   default=5)
    parser.add_argument("--batch-size",             type=int,   default=4)
    parser.add_argument("--lr",                     type=float, default=5e-4)
    parser.add_argument("--val-split",              type=float, default=0.1,
                        help="Validation için ayrılacak veri oranı (0.0 = kapalı)")
    parser.add_argument("--max-samples",            type=int,   default=0,
                        help="Eğitimde kullanılacak maksimum paragraf sayısı (0 = hepsi)")
    parser.add_argument("--sample-prompt",          type=str,   default="Yapay zeka nedir?",
                        help="Her epoch sonunda üretilecek örnek prompt")
    parser.add_argument("--gradient-checkpointing", action="store_true",
                        help="Büyük modellerde bellek tasarrufu için gradient checkpointing")

    # Sohbet
    parser.add_argument("--message",       type=str)
    parser.add_argument("--checkpoint",    type=str)
    parser.add_argument("--max-length",    type=int,   default=150)
    parser.add_argument("--temperature",   type=float, default=0.8)
    parser.add_argument("--beam-search",   action="store_true",
                        help="Sampling yerine beam search kullan")
    parser.add_argument("--num-beams",     type=int,   default=4,
                        help="Beam search için beam sayısı")

    args = parser.parse_args()

    if args.mode == "train":
        train_mode(args)
    elif args.mode == "chat":
        if not args.message:
            print("❌ --message gerekli")
            return
        chat_mode(args)
    elif args.mode == "interactive":
        interactive_mode(args)
    elif args.mode == "demo":
        demo_mode(args)


if __name__ == "__main__":
    main()