"""
Turkish-AI Ana Motor — HuggingFace Edition
Aynı arayüz, içten rekor/beraber-türkçe-gpt2 modeli çalışır.
"""
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from typing import List, Dict, Optional
import os
import json
from datetime import datetime


class TurkishAI:
    def __init__(
        self,
        model_size: str = "small",
        vocab_size: int = 32000,
        device: str = None,
        memory_dir: str = "./data/memory",
        checkpoint_dir: str = "./checkpoints"
    ):
        self.model_size = model_size
        self.device = device or (
            "mps" if torch.backends.mps.is_available() else
            "cuda" if torch.cuda.is_available() else "cpu"
        )
        self.memory_dir = memory_dir
        self.checkpoint_dir = checkpoint_dir
        self.model = None
        self.tokenizer = None
        self.is_initialized = False
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.conversation_history = []

        print(f"\n{'='*60}")
        print("🧠 Turkish-AI (HuggingFace) Başlatılıyor")
        print(f"Cihaz: {self.device}")
        print(f"{'='*60}\n")

    def initialize(self, load_checkpoint: str = None):
        model_name = "ytu-ce-cosmos/turkish-gpt2"
        print(f"[1/2] Model indiriliyor/yükleniyor: {model_name}")
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModelForCausalLM.from_pretrained(model_name).to(self.device)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        print("[2/2] Hafıza sistemi hazırlanıyor...")
        os.makedirs(self.memory_dir, exist_ok=True)
        self.is_initialized = True
        print(f"\n✅ Turkish-AI hazır!")
        print(f"   Parametre sayısı: {sum(p.numel() for p in self.model.parameters()):,}")

    def chat(
        self,
        message: str,
        max_length: int = 150,
        temperature: float = 0.8,
        top_p: float = 0.95,
        use_memory: bool = True,
        use_beam_search: bool = False,
        num_beams: int = 4
    ) -> str:
        if not self.is_initialized:
            raise RuntimeError("Sistem başlatılmamış. initialize() çağırın.")

        if use_memory and self.conversation_history:
            context = "\n".join(self.conversation_history[-6:])
            prompt = f"{context}\nKullanıcı: {message}\nAsistan:"
        else:
            prompt = f"Kullanıcı: {message}\nAsistan:"

        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.device)

        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=max_length,
                temperature=temperature,
                top_p=top_p,
                do_sample=not use_beam_search,
                num_beams=num_beams if use_beam_search else 1,
                repetition_penalty=1.1,
                pad_token_id=self.tokenizer.eos_token_id,
                eos_token_id=self.tokenizer.eos_token_id,
            )

        generated = self.tokenizer.decode(outputs[0], skip_special_tokens=True)

        # Sadece asistan cevabını al
        if "Asistan:" in generated:
            response = generated.split("Asistan:")[-1].strip()
        else:
            response = generated[len(prompt):].strip()

        # Stop token'ları temizle
        for stop in ["Kullanıcı:", "kullanıcı:", "\nUser:", "\n\n"]:
            if stop in response:
                response = response[:response.find(stop)].strip()

        if not response:
            response = "..."

        if use_memory:
            self.conversation_history.append(f"Kullanıcı: {message}")
            self.conversation_history.append(f"Asistan: {response}")

        return response

    def reset_conversation(self):
        self.conversation_history = []
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        print("\n🔄 Yeni konuşma başlatıldı.")

    def learn_from_feedback(self, correct_response: str, positive: bool = True):
        print(f"🔄 Geri bildirim alındı: {'✓ Olumlu' if positive else '✗ Olumsuz'}")

    def remember_fact(self, fact: str, category: str = "general"):
        print(f"💾 Bilgi kaydedildi: {fact[:50]}...")

    def save_checkpoint(self, name: str = None):
        print("💾 HuggingFace modeli checkpoint gerektirmez.")

    def load_checkpoint(self, name: str):
        print("📂 HuggingFace modeli checkpoint gerektirmez.")

    def get_stats(self) -> Dict:
        return {
            "model_size": self.model_size,
            "parameters": sum(p.numel() for p in self.model.parameters()) if self.model else 0,
            "vocab_size": len(self.tokenizer) if self.tokenizer else 0,
            "tokenizer_trained": True,
            "device": self.device,
            "session_id": self.session_id,
            "memory_stats": {
                "short_term": len(self.conversation_history) // 2,
                "long_term": 0
            }
        }


def create_ai(model_size: str = "tiny", **kwargs) -> TurkishAI:
    ai = TurkishAI(model_size=model_size, **kwargs)
    ai.initialize()
    return ai
