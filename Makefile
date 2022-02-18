.PHONY: up run

up:
	git add .
	git commit -am "update"
	git pull origin master
	git push origin master
	@echo "\n 代码提交发布..."

run:
	go run main.go